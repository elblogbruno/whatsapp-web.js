'use strict';

/**
 * Memory monitoring utility for Client.
 * Collects Node.js and browser-side heap metrics, emits events, and
 * optionally triggers auto-restart when a memory budget is exceeded.
 */
class MemoryMonitor {
    constructor(client) {
        this.client = client;
        this.monitorInterval = null;
    }

    /**
     * Get current memory metrics from Node.js process and the Chromium renderer.
     * @returns {Promise<Object>} Snapshot of memory metrics
     */
    async getMetrics() {
        const nodeMetrics = process.memoryUsage();

        let browserMetrics = null;
        try {
            if (this.client.pupPage && !this.client.pupPage.isClosed()) {
                browserMetrics = await this.client.pupPage.evaluate(() => {
                    if (!window.Store) return null;

                    return {
                        messages:    window.Store.Msg?.models?.length     || 0,
                        chats:       window.Store.Chat?.models?.length    || 0,
                        contacts:    window.Store.Contact?.models?.length || 0,
                        calls:       window.Store.Call?.models?.length    || 0,
                        blobCacheSize: window.Store.BlobCache?._cache
                            ? Object.keys(window.Store.BlobCache._cache).length
                            : 0,
                        performanceMemory: (typeof performance !== 'undefined' && performance.memory)
                            ? {
                                usedJSHeapSize:  performance.memory.usedJSHeapSize,
                                totalJSHeapSize: performance.memory.totalJSHeapSize,
                                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                            }
                            : null,
                    };
                });
            }
        } catch (_) {
            browserMetrics = null;
        }

        return {
            node: {
                rss:          nodeMetrics.rss,
                heapUsed:     nodeMetrics.heapUsed,
                heapTotal:    nodeMetrics.heapTotal,
                external:     nodeMetrics.external,
                arrayBuffers: nodeMetrics.arrayBuffers || 0,
            },
            browser:   browserMetrics,
            timestamp: Date.now(),
        };
    }

    /**
     * Start periodic memory monitoring.
     * Emits `memory_metrics` on every tick and `memory_budget_exceeded` when the
     * configured RSS budget is surpassed.
     * @param {number} [intervalMs=30000] Polling interval in milliseconds
     */
    startMonitoring(intervalMs = 30000) {
        if (this.monitorInterval) return; // already running

        this.monitorInterval = setInterval(async () => {
            try {
                const metrics = await this.getMetrics();
                this.client.emit('memory_metrics', metrics);

                if (
                    this.client.options.memoryBudget &&
                    metrics.node.rss > this.client.options.memoryBudget
                ) {
                    this.client.emit('memory_budget_exceeded', metrics);

                    if (this.client.options.onMemoryBudgetExceeded === 'restart') {
                        console.warn('[wwebjs] Memory budget exceeded – destroying client');
                        this.stopMonitoring();
                        await this.client.destroy();
                    }
                }
            } catch (_) {
                // Silently continue on transient errors
            }
        }, intervalMs);
    }

    /**
     * Stop periodic memory monitoring and clear the interval.
     */
    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }
}

module.exports = MemoryMonitor;
