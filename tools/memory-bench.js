#!/usr/bin/env node
/**
 * Memory benchmark harness for whatsapp-web.js
 *
 * Usage:
 *   node tools/memory-bench.js [options]
 *
 * Options:
 *   --sessions=N      Number of Client sessions to spawn (default: 1)
 *   --duration=N      Measurement duration in seconds after ready (default: 120)
 *   --interval=N      Metrics polling interval in seconds (default: 10)
 *   --out=FILE        Output JSONL file (default: memory-bench-<ts>.jsonl)
 *
 * Metrics collected every --interval seconds:
 *   - Node.js RSS, heapUsed, heapTotal, external, arrayBuffers
 *   - Chrome process RSS (via `ps`)
 *   - Browser JS heap via page.metrics()
 *   - Store sizes (Msg, Chat, Contact counts)
 *   - Event-loop delay (via perf_hooks monitorEventLoopDelay)
 *
 * Workflow:
 *   1. Baseline run  → node tools/memory-bench.js --out=baseline.jsonl
 *   2. Apply patches
 *   3. Patched run   → node tools/memory-bench.js --out=patched.jsonl
 *   4. Compare       → node tools/memory-bench.js --compare baseline.jsonl patched.jsonl
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync }              = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');

// ── Parse CLI args ────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

// Compare mode
if (rawArgs[0] === '--compare') {
    const [, baseFile, patchedFile] = rawArgs;
    if (!baseFile || !patchedFile) {
        console.error('Usage: --compare <baseline.jsonl> <patched.jsonl>');
        process.exit(1);
    }
    compare(baseFile, patchedFile);
    process.exit(0);
}

const argMap = Object.fromEntries(
    rawArgs.filter(a => a.startsWith('--')).map(a => a.replace(/^--/, '').split('='))
);

const NUM_SESSIONS   = parseInt(argMap.sessions  ?? '1');
const DURATION_SEC   = parseInt(argMap.duration  ?? '120');
const INTERVAL_SEC   = parseInt(argMap.interval  ?? '10');
const OUT_FILE       = argMap.out ?? `memory-bench-${Date.now()}.jsonl`;

// ── Setup ─────────────────────────────────────────────────────────────────────
let { Client, LocalAuth } = (() => {
    try {
        return require('..');                   // running from repo root
    } catch {
        return require('whatsapp-web.js');      // running from project that depends on it
    }
})();

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

/** @type {Client[]} */
const clients = [];
const metrics = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getChromeRss() {
    try {
        const out = execSync(
            'ps -eo rss,comm | grep -E "chrome|chromium" | awk \'{sum+=$1} END {print sum}\'',
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
        ).trim();
        const kb = parseInt(out) || 0;
        return kb * 1024; // KB → bytes
    } catch {
        return -1;
    }
}

async function collectMetrics(label) {
    const node        = process.memoryUsage();
    const chromeRss   = getChromeRss();
    const evLoopMs    = histogram.mean / 1e6;   // nanoseconds → milliseconds
    histogram.reset();

    const browserData = await Promise.all(clients.map(async (c, i) => {
        if (!c.pupPage || c.pupPage.isClosed()) return null;
        try {
            const pm = await c.pupPage.metrics();
            const ss = await c.pupPage.evaluate(() => ({
                msgs:     window.Store?.Msg?.models?.length     ?? -1,
                chats:    window.Store?.Chat?.models?.length    ?? -1,
                contacts: window.Store?.Contact?.models?.length ?? -1,
            })).catch(() => ({ msgs: -1, chats: -1, contacts: -1 }));
            return { session: i, ...pm, stores: ss };
        } catch {
            return { session: i, error: true };
        }
    }));

    const row = {
        ts: Date.now(),
        label,
        node: {
            rss:          node.rss,
            heapUsed:     node.heapUsed,
            heapTotal:    node.heapTotal,
            external:     node.external,
            arrayBuffers: node.arrayBuffers ?? 0,
        },
        chromeRss,
        eventLoopDelayMs: +evLoopMs.toFixed(2),
        browser: browserData.filter(Boolean),
    };

    metrics.push(row);
    fs.appendFileSync(OUT_FILE, JSON.stringify(row) + '\n');

    const rssM   = (node.rss        / 1024 / 1024) | 0;
    const heapM  = (node.heapUsed   / 1024 / 1024) | 0;
    const chrM   = chromeRss > 0 ? ((chromeRss / 1024 / 1024) | 0) + ' MB' : 'n/a';
    console.log(
        `[${new Date().toISOString()}] [${label.padEnd(16)}] ` +
        `node-RSS=${rssM}MB  heapUsed=${heapM}MB  chrome-RSS=${chrM}  evLoop=${evLoopMs.toFixed(1)}ms`
    );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`─────────────────────────────────────────────────────────────`);
    console.log(` Memory benchmark  │  sessions=${NUM_SESSIONS}  duration=${DURATION_SEC}s`);
    console.log(` Output → ${OUT_FILE}`);
    console.log(`─────────────────────────────────────────────────────────────`);

    // Spawn clients
    for (let i = 0; i < NUM_SESSIONS; i++) {
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: `bench-${i}` }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            },
            enableMemoryOptimization: true,
        });

        client.on('qr',          () => console.log(`[session-${i}] ▶ QR ready – scan to authenticate`));
        client.on('ready',       () => console.log(`[session-${i}] ✓ READY`));
        client.on('auth_failure', e => console.error(`[session-${i}] ✗ AUTH FAILURE`, e));
        clients.push(client);
    }

    await collectMetrics('before_init');

    // Initialize all sessions in parallel
    await Promise.all(clients.map(c => c.initialize().catch(e => {
        console.error('initialize() error:', e.message);
    })));

    await collectMetrics('after_init');

    // Periodic idle measurement
    const interval = setInterval(() => collectMetrics('idle'), INTERVAL_SEC * 1000);

    // Wait for configured measurement window
    await new Promise(r => setTimeout(r, DURATION_SEC * 1000));
    clearInterval(interval);

    await collectMetrics('final');

    // Teardown
    await Promise.all(clients.map(c => c.destroy().catch(() => {})));
    await new Promise(r => setTimeout(r, 1000));
    await collectMetrics('after_destroy');

    console.log(`\n✓ Done – results saved to ${path.resolve(OUT_FILE)}`);
    printSummary(metrics);
    process.exit(0);
}

function printSummary(rows) {
    const byLabel = {};
    rows.forEach(r => { byLabel[r.label] = r; });
    const labels = Object.keys(byLabel);
    if (labels.length < 2) return;

    console.log('\n── Summary ───────────────────────────────────────────────────');
    console.log('Label           │ node-RSS  │ heapUsed │ chrome-RSS');
    labels.forEach(l => {
        const r = byLabel[l];
        const rss   = r.node.rss          > 0 ? ((r.node.rss        / 1024 / 1024) | 0) + ' MB' : 'n/a';
        const heap  = r.node.heapUsed     > 0 ? ((r.node.heapUsed   / 1024 / 1024) | 0) + ' MB' : 'n/a';
        const chr   = r.chromeRss         > 0 ? ((r.chromeRss       / 1024 / 1024) | 0) + ' MB' : 'n/a';
        console.log(`${l.padEnd(15)} │ ${rss.padEnd(9)} │ ${heap.padEnd(8)} │ ${chr}`);
    });
    console.log('──────────────────────────────────────────────────────────────');
}

// ── Compare mode ──────────────────────────────────────────────────────────────
function compare(baseFile, patchedFile) {
    const load = f => fs.readFileSync(f, 'utf8')
        .split('\n').filter(Boolean).map(JSON.parse);

    const base    = load(baseFile);
    const patched = load(patchedFile);

    const pick = (rows, label) => rows.find(r => r.label === label) ||
                                  rows[rows.length - 1];

    const bFinal = pick(base,    'final');
    const pFinal = pick(patched, 'final');

    const diff = (a, b) => {
        const d = b - a;
        const sign = d >= 0 ? '+' : '';
        return `${sign}${(d / 1024 / 1024) | 0} MB`;
    };

    console.log('\n── Before vs After ───────────────────────────────────────────');
    console.log('Metric            │ Baseline           │ Patched            │ Diff');
    const rows = [
        ['node RSS',     bFinal.node.rss,      pFinal.node.rss],
        ['node heapUsed',bFinal.node.heapUsed,  pFinal.node.heapUsed],
        ['chrome RSS',   bFinal.chromeRss,       pFinal.chromeRss],
    ];
    rows.forEach(([name, bv, pv]) => {
        const bStr = bv > 0 ? ((bv / 1024 / 1024) | 0) + ' MB' : 'n/a';
        const pStr = pv > 0 ? ((pv / 1024 / 1024) | 0) + ' MB' : 'n/a';
        const dStr = bv > 0 && pv > 0 ? diff(bv, pv) : 'n/a';
        console.log(`${name.padEnd(17)} │ ${bStr.padEnd(18)} │ ${pStr.padEnd(18)} │ ${dStr}`);
    });
    console.log('──────────────────────────────────────────────────────────────');
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
