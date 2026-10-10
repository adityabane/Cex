import { redis } from "../apps/engine/redis";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const ENGINE_METRICS_KEY = "cex:metrics:engine";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
let SELLERS = (process.env.SELLER_TOKENS ?? "").split(",").map(x => x.trim()).filter(Boolean);
let BUYERS = (process.env.BUYER_TOKENS ?? "").split(",").map(x => x.trim()).filter(Boolean);
let ASSET = (process.env.ASSET ?? "").trim().toUpperCase();
const PRICE = Number(process.env.PRICE ?? 1);
const QTY = Number(process.env.QTY ?? 0.001);
const DURATION = Math.max(5, Number(process.env.DURATION_SECONDS ?? 30));
const DRAIN = Math.max(0, Number(process.env.DRAIN_SECONDS ?? 10));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));
const STREAM = "cex:orders";
const GROUP = "cex-order-engine";
type Hash = Record<string, string>;
type Queue = { lag: number; pending: number };
const n = (v?: string) => Number(v ?? 0);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function loginPrompt(rl: ReturnType<typeof createInterface>, role: string): Promise<string> {
    const email = (await rl.question(`${role} test account email: `)).trim();
    const password = await rl.question(`${role} test account password: `);
    if (!email || !password) throw new Error(`${role} email and password are required.`);
    const response = await fetch(`${BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    const body = await response.json().catch(() => ({})) as { token?: string; error?: string };
    if (!response.ok || !body.token) {
        throw new Error(`${role} login failed (HTTP ${response.status}): ${body.error ?? "No token returned"}`);
    }
    console.log(`${role} login successful; JWT kept in memory.`);
    return body.token;
}

async function setupInputs() {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        if (!ASSET) ASSET = (await rl.question("Asset symbol to test (e.g. BTC): ")).trim().toUpperCase();
        if (!ASSET) throw new Error("Asset symbol is required.");
        if (!SELLERS.length) SELLERS = [await loginPrompt(rl, "SELLER")];
        if (!BUYERS.length) BUYERS = [await loginPrompt(rl, "BUYER")];
    } finally {
        rl.close();
    }
    if (!SELLERS.length || !BUYERS.length) throw new Error("A seller and buyer token are required.");
}

async function metrics(): Promise<Hash> {
    return await redis.hgetall(ENGINE_METRICS_KEY) as Hash;
}
async function queue(): Promise<Queue> {
    const groups = await redis.xinfo("GROUPS", STREAM) as unknown as Array<Array<string | number | null>>;
    const row = groups.find(r => {
        for (let i = 0; i + 1 < r.length; i += 2)
            if (String(r[i]) === "name" && String(r[i + 1]) === GROUP) return true;
        return false;
    });
    const f: Hash = {};
    if (row) for (let i = 0; i + 1 < row.length; i += 2) f[String(row[i])] = String(row[i + 1] ?? "");
    const xp = await redis.xpending(STREAM, GROUP) as unknown as unknown[];
    return { lag: n(f.lag), pending: n(String(xp[0] ?? f.pending ?? 0)) };
}
const stats = { accepted: 0, limited429: 0, rejected503: 0, httpErrors: 0, networkErrors: 0, latencies: [] as number[] };

async function post(token: string, side: "BUY" | "SELL") {
    const t = performance.now();
    try {
        const r = await fetch(`${BASE_URL}/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ asset: ASSET, side, type: "LIMIT", qty: QTY, price: PRICE }),
        });
        stats.latencies.push(performance.now() - t);
        if (r.status === 200 || r.status === 201) stats.accepted++;
        else if (r.status === 429) stats.limited429++;
        else if (r.status === 503) stats.rejected503++;
        else {
            stats.httpErrors++;
            if (stats.httpErrors <= 5) console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        }
    } catch (e) {
        stats.networkErrors++;
        if (stats.networkErrors <= 5) console.error(e);
    }
}
function pct(values: number[], p: number) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a,b) => a-b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

async function main() {
    await setupInputs();
    console.log(`Settings: asset=${ASSET}, price=${PRICE}, qty=${QTY}, duration=${DURATION}s, concurrency=${CONCURRENCY}`);
    console.log("Precondition: use dedicated funded test accounts; seller needs the asset and buyer needs USDT.");
    const startTime = Date.now();
    const endLoad = startTime + DURATION * 1000;
    const startQ = await queue();
    const startM = await metrics();
    const samples: Array<{ at: number; q: Queue; m: Hash }> = [];
    let stop = false;
    const sampler = (async () => {
        while (!stop) {
            const [q, m] = await Promise.all([queue(), metrics()]);
            samples.push({ at: Date.now(), q, m });
            await sleep(1000);
        }
    })();

    console.log(`Running ${DURATION}s workload; concurrency=${CONCURRENCY}; asset=${ASSET}`);
    await Promise.all(Array.from({ length: CONCURRENCY }, async (_, i) => {
        const seller = SELLERS[i % SELLERS.length]!;
        const buyer = BUYERS[i % BUYERS.length]!;
        while (Date.now() < endLoad) {
            await post(seller, "SELL");
            await post(buyer, "BUY");
        }
    }));

    console.log(`Load phase complete; observing for another ${DRAIN}s`);
    await sleep(DRAIN * 1000);
    stop = true;
    await sampler;
    await sleep(1100); // allow the metrics module's one-second flush

    const endQ = await queue();
    const endM = await metrics();
    const elapsed = Math.max(1, (Date.now() - startTime) / 1000);
    const processed = Math.max(0, n(endM.processedOrders) - n(startM.processedOrders));
    const failures = Math.max(0, n(endM.failedAttempts) - n(startM.failedAttempts));
    const dbCount = Math.max(0, n(endM.dbOperationCount) - n(startM.dbOperationCount));
    const dbMs = Math.max(0, n(endM.dbOperationDurationMs) - n(startM.dbOperationDurationMs));
    const processMs = Math.max(0, n(endM.processingDurationMs) - n(startM.processingDurationMs));

    console.log("\n========== CEX V2 AUTOMATED REPORT ==========");
    console.log(JSON.stringify({
        elapsedSeconds: +elapsed.toFixed(2),
        http: {
            accepted: stats.accepted,
            acceptedPerSecond: +(stats.accepted / elapsed).toFixed(2),
            rateLimited429: stats.limited429,
            backpressure503: stats.rejected503,
            otherHttpErrors: stats.httpErrors,
            networkErrors: stats.networkErrors,
            avgLatencyMs: +(stats.latencies.reduce((a,b) => a+b, 0) / Math.max(1, stats.latencies.length)).toFixed(2),
            p95LatencyMs: +pct(stats.latencies, 0.95).toFixed(2),
        },
        engine: {
            processedSuccessfully: processed,
            successfulOrdersPerSecond: +(processed / elapsed).toFixed(2),
            failedProcessingAttempts: failures,
            averageEndToEndProcessingMs: +(processMs / Math.max(1, processed)).toFixed(2),
            instrumentedDbOperationCount: dbCount,
            averageInstrumentedDbOperationMs: +(dbMs / Math.max(1, dbCount)).toFixed(2),
            lastFlushMaxProcessingMs: n(endM.lastFlushMaxProcessingDurationMs),
            lastFlushMaxDbOperationMs: n(endM.lastFlushMaxDbOperationDurationMs),
        },
        queue: {
            startLag: startQ.lag, endLag: endQ.lag, lagChange: endQ.lag - startQ.lag,
            startPending: startQ.pending, endPending: endQ.pending,
        },
        note: "Engine counters are process-wide, and DB latency includes only instrumented calls. Use no unrelated load for a clean baseline.",
    }, null, 2));
    console.log("=============================================\n");
    await redis.quit();
}

main().catch(async e => {
    console.error("Benchmark failed:", e);
    try { await redis.quit(); } catch {}
    process.exitCode = 1;
});
