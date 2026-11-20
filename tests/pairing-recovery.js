const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const Client = require('../src/Client');

function setup() {
    const state = {
        secret: 'initial-secret',
        registration: { identityKeyPair: { pubKey: 'identity' } },
        noise: { staticKeyPair: { pubKey: 'noise' } },
        failure: null,
        recoveryFailure: null,
        restored: 0,
        refreshes: [],
        warnings: [],
    };
    const conn = new EventEmitter();
    conn.ref = 'ref';
    const socket = new EventEmitter();
    socket.state = 'UNPAIRED';
    const secrets = new EventEmitter();
    const timers = new Map();
    let timerId = 0;
    const modules = {
        WAWebCmd: { Cmd: {} },
        WAWebConnModel: { Conn: conn },
        WAWebSocketModel: { Socket: socket },
        WAWebSignalStoreApi: {
            waSignalStore: {
                getRegistrationInfo: async () => state.registration,
            },
        },
        WAWebUserPrefsInfoStore: {
            waNoiseInfo: { get: async () => state.noise },
        },
        WAWebUserPrefsMultiDevice: {
            getADVSecretKey: () => state.secret,
            advSecretEventEmitter: secrets,
        },
        WABase64: { encodeB64: (value) => value },
        WAWebCompanionRegClientUtils: { DEVICE_PLATFORM: 'test' },
        WAWebAltDeviceLinkingApi: {
            setPairingType() {},
            async initializeAltDeviceLinking() {
                state.secret = undefined;
                secrets.emit('change');
            },
            async startAltLinkingFlow() {
                if (state.failure) throw state.failure;
                return 'ABCD1234';
            },
            async initializeQRLinking() {
                if (state.recoveryFailure) throw state.recoveryFailure;
                state.restored++;
                state.secret = `restored-${state.restored}`;
                secrets.emit('change');
            },
        },
        WAWebLaunchSocketUtils: {
            refreshQR: async () => state.refreshes.push(state.secret),
        },
    };
    const pageWindow = {
        require(name) {
            if (!(name in modules))
                throw new Error(`Module unavailable: ${name}`);
            return modules[name];
        },
    };
    const context = vm.createContext({
        window: pageWindow,
        console: { warn: (...args) => state.warnings.push(args) },
        setInterval(callback) {
            timers.set(++timerId, callback);
            return timerId;
        },
        clearInterval(id) {
            timers.delete(id);
        },
    });
    const client = new Client({ pairWithPhoneNumber: { phoneNumber: '' } });
    const qrs = [];
    const codes = [];
    client.on('qr', (qr) => qrs.push(qr));
    client.on('code', (code) => codes.push(code));
    client.setDeviceName = async () => {};
    client.getWWebVersion = async () => '2.3000.test';
    client.pupPage = {
        waitForFunction: async () => ({
            jsonValue: async () => ({ need: true }),
        }),
        async exposeFunction(name, callback) {
            pageWindow[name] = callback;
            if (name === 'onAuthAppStateChangedEvent') {
                throw new Error('stop after QR setup');
            }
        },
        async evaluate(callback, ...args) {
            context.args = args;
            return vm.runInContext(
                `(${callback.toString()})(...args)`,
                context,
            );
        },
    };
    return {
        client,
        state,
        conn,
        socket,
        secrets,
        timers,
        qrs,
        codes,
        pageWindow,
    };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Pairing failure recovery', function () {
    it('refreshes idle QR through LaunchSocketUtils without the removed Cmd API', async function () {
        const test = setup();
        await assert.rejects(test.client.inject(), /stop after QR setup/);
        await test.pageWindow.onAuthAppStateChangedEvent('UNPAIRED');
        assert.equal(test.state.refreshes.length, 0);
        await test.pageWindow.onAuthAppStateChangedEvent('UNPAIRED_IDLE');
        assert.deepEqual(test.state.refreshes, ['initial-secret']);
        test.client.options.pairWithPhoneNumber.phoneNumber = '123';
        await test.pageWindow.onAuthAppStateChangedEvent('UNPAIRED_IDLE');
        assert.equal(test.state.refreshes.length, 1);
    });

    it('waits for the idle QR refresh and propagates its failure', async function () {
        const test = setup();
        await assert.rejects(test.client.inject(), /stop after QR setup/);
        test.pageWindow.require('WAWebLaunchSocketUtils').refreshQR =
            async () => {
                throw new Error('refresh failed');
            };
        await assert.rejects(
            test.pageWindow.onAuthAppStateChangedEvent('UNPAIRED_IDLE'),
            /refresh failed/,
        );
    });

    it('propagates configured phone pairing failures through inject', async function () {
        const test = setup();
        test.client.options.pairWithPhoneNumber.phoneNumber = '123';
        test.state.failure = new Error('initial-phone-pairing-failed');
        await assert.rejects(
            test.client.inject(),
            /initial-phone-pairing-failed/,
        );
        assert.equal(test.timers.size, 0);
        assert.equal(test.state.restored, 1);
    });

    it('supports QR updates without the optional secret event emitter', async function () {
        const test = setup();
        delete test.pageWindow.require('WAWebUserPrefsMultiDevice')
            .advSecretEventEmitter;
        await assert.rejects(test.client.inject(), /stop after QR setup/);
        test.state.secret = 'new-secret';
        test.conn.emit('change:ref');
        await flush();
        assert.equal(test.qrs.at(-1), 'ref,noise,identity,new-secret,test');
        test.socket.emit('change:hasSynced');
        assert.equal(test.conn.listenerCount('change:ref'), 0);
    });

    it('waits for a secret and reads current keys on every QR update', async function () {
        const test = setup();
        test.state.secret = undefined;
        await assert.rejects(test.client.inject(), /stop after QR setup/);
        assert.equal(test.qrs.length, 0);
        test.state.secret = 'new-secret';
        test.secrets.emit('change');
        await flush();
        assert.equal(test.qrs.at(-1), 'ref,noise,identity,new-secret,test');

        test.conn.ref = 'new-ref';
        test.state.registration.identityKeyPair.pubKey = 'new-identity';
        test.state.noise.staticKeyPair.pubKey = 'new-noise';
        test.state.secret = 'rotated-secret';
        test.conn.emit('change:ref', test.conn, test.conn.ref);
        await flush();
        assert.equal(
            test.qrs.at(-1),
            'new-ref,new-noise,new-identity,rotated-secret,test',
        );
        test.socket.emit('change:hasSynced');
        assert.equal(test.conn.listenerCount('change:ref'), 0);
        assert.equal(test.secrets.listenerCount('change'), 0);
    });

    it('does not emit QR codes with missing registration keys or reference', async function () {
        for (const missing of ['registration', 'noise', 'ref']) {
            const test = setup();
            if (missing === 'ref') test.conn.ref = null;
            else test.state[missing] = null;
            await assert.rejects(test.client.inject(), /stop after QR setup/);
            assert.equal(test.qrs.length, 0);
        }
    });

    it('restores QR and removes old timers on an initial rate-limit failure', async function () {
        const test = setup();
        await assert.rejects(test.client.inject(), /stop after QR setup/);
        test.pageWindow.codeInterval = 99;
        test.timers.set(99, () => {});
        test.state.failure = Object.assign(new Error('CompanionHelloError'), {
            code: 429,
        });
        await assert.rejects(test.client.requestPairingCode('123'), (error) => {
            assert.match(error.message, /CompanionHelloError/);
            assert.match(error.message, /"code":429/);
            return true;
        });
        await flush();
        assert.equal(test.timers.size, 0);
        assert.equal(test.pageWindow.codeInterval, undefined);
        assert.equal(test.state.restored, 1);
        assert.deepEqual(test.state.refreshes, ['restored-1']);
        assert.equal(test.qrs.at(-1), 'ref,noise,identity,restored-1,test');
        assert.equal(test.codes.length, 0);
    });

    it('stops rotations and handles a later failure without an unhandled rejection', async function () {
        const test = setup();
        assert.equal(await test.client.requestPairingCode('123'), 'ABCD1234');
        assert.deepEqual(test.codes, ['ABCD1234']);
        assert.equal(test.timers.size, 1);
        test.state.failure = new Error('rate-overlimit');
        await test.timers.values().next().value();
        assert.equal(test.timers.size, 0);
        assert.equal(test.pageWindow.codeInterval, undefined);
        assert.equal(test.state.restored, 1);
        assert.equal(test.state.warnings.length, 1);
        assert.deepEqual(test.codes, ['ABCD1234']);
    });

    it('preserves the original rejection if restoring QR also fails', async function () {
        const test = setup();
        test.state.failure = new Error('original-pairing-error');
        test.state.recoveryFailure = new Error('QR-recovery-error');
        await assert.rejects(
            test.client.requestPairingCode('123'),
            /original-pairing-error/,
        );
        assert.equal(test.timers.size, 0);
    });

    it('restores the secret before refreshing QR on explicit cancellation', async function () {
        const test = setup();
        await test.client.requestPairingCode('123');
        await test.client.cancelPairingCode();
        assert.equal(test.timers.size, 0);
        assert.equal(test.pageWindow.codeInterval, undefined);
        assert.deepEqual(test.state.refreshes, ['restored-1']);
    });

    it('clears the rotation handle when the client becomes authenticated', async function () {
        const test = setup();
        await test.client.requestPairingCode('123');
        test.socket.state = 'CONNECTED';
        await test.timers.values().next().value();
        assert.equal(test.timers.size, 0);
        assert.equal(test.pageWindow.codeInterval, undefined);
        assert.equal(test.state.restored, 0);
    });
});
