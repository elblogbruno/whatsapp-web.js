const exposedFunctionsByPage = new WeakMap();

/**
 * Expose a function to the page if it does not exist.
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    let exposedFunctions = exposedFunctionsByPage.get(page);
    if (!exposedFunctions) {
        exposedFunctions = {
            names: new Set(),
            pending: new Map(),
        };
        exposedFunctionsByPage.set(page, exposedFunctions);
    }

    if (exposedFunctions.names.has(name)) {
        return;
    }

    if (exposedFunctions.pending.has(name)) {
        return exposedFunctions.pending.get(name);
    }

    const exposePromise = (async () => {
        try {
            const exist = await page.evaluate((bindingName) => {
                return !!window[bindingName];
            }, name);

            if (!exist) {
                await page.exposeFunction(name, fn);
            }

            exposedFunctions.names.add(name);
        } catch (error) {
            const message = error?.message || String(error);
            if (message.includes(`window['${name}'] already exists!`)) {
                exposedFunctions.names.add(name);
                return;
            }

            throw error;
        } finally {
            exposedFunctions.pending.delete(name);
        }
    })();

    exposedFunctions.pending.set(name, exposePromise);
    return exposePromise;
}

module.exports = { exposeFunctionIfAbsent };
