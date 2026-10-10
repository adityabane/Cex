import { redis } from "./redis";

export const ENGINE_METRICS_KEY = "cex:metrics:engine";

type Counters = {
    processedOrders: number;
    processingDurationMs: number;
    failedAttempts: number;
    dbOperationCount: number;
    dbOperationDurationMs: number;
    maxProcessingDurationMs: number;
    maxDbOperationDurationMs: number;
};
const empty = (): Counters => ({
    processedOrders: 0, processingDurationMs: 0, failedAttempts: 0,
    dbOperationCount: 0, dbOperationDurationMs: 0,
    maxProcessingDurationMs: 0, maxDbOperationDurationMs: 0,
});
let pending = empty();
let flushing = false;

export function recordOrderProcessed(ms: number) {
    pending.processedOrders++;
    pending.processingDurationMs += Math.max(0, ms);
    pending.maxProcessingDurationMs = Math.max(pending.maxProcessingDurationMs, ms);
}
export function recordOrderFailed() { pending.failedAttempts++; }
export function recordDbOperation(ms: number) {
    pending.dbOperationCount++;
    pending.dbOperationDurationMs += Math.max(0, ms);
    pending.maxDbOperationDurationMs = Math.max(pending.maxDbOperationDurationMs, ms);
}
export async function measureDbOperation<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await fn(); }
    finally { recordDbOperation(performance.now() - start); }
}

async function flush() {
    if (flushing) return;
    const batch = pending;
    pending = empty();
    if (!Object.values(batch).some((v) => v !== 0)) return;
    flushing = true;
    try {
        const p = redis.pipeline();
        p.hincrby(ENGINE_METRICS_KEY, "processedOrders", batch.processedOrders);
        p.hincrby(ENGINE_METRICS_KEY, "processingDurationMs", Math.round(batch.processingDurationMs));
        p.hincrby(ENGINE_METRICS_KEY, "failedAttempts", batch.failedAttempts);
        p.hincrby(ENGINE_METRICS_KEY, "dbOperationCount", batch.dbOperationCount);
        p.hincrby(ENGINE_METRICS_KEY, "dbOperationDurationMs", Math.round(batch.dbOperationDurationMs));
        p.hset(
            ENGINE_METRICS_KEY,
            "lastFlushMaxProcessingDurationMs", Math.round(batch.maxProcessingDurationMs),
            "lastFlushMaxDbOperationDurationMs", Math.round(batch.maxDbOperationDurationMs),
            "lastFlushAt", Date.now(),
        );
        await p.exec();
    } catch (error) {
        console.error("Could not flush engine metrics:", error);
    } finally { flushing = false; }
}
setInterval(() => { void flush(); }, 1000);
