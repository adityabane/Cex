import { redis } from "../engine/redis";

const STREAM = "cex:orders";
const GROUP = "cex-order-engine";
const BURST = Math.max(1, Number(process.env.ORDER_RATE_BURST ?? 10));
const REFILL = Math.max(0.1, Number(process.env.ORDER_RATE_PER_SECOND ?? 5));
const MAX_BACKLOG = Math.max(1, Number(process.env.MAX_ORDER_BACKLOG ?? 50_000));

const TOKEN_BUCKET = `
local v = redis.call("HMGET", KEYS[1], "tokens", "timestamp")
local cap = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local now = tonumber(ARGV[1])
local tokens = tonumber(v[1]) or cap
local last = tonumber(v[2]) or now
tokens = math.min(cap, tokens + math.max(0, now - last) * rate / 1000)
local allowed = 0
local retry = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1
else retry = math.ceil((1 - tokens) * 1000 / rate) end
redis.call("HSET", KEYS[1], "tokens", tokens, "timestamp", now)
redis.call("PEXPIRE", KEYS[1], 120000)
return { allowed, retry }
`;

type Fields = Record<string, string>;
let backlogCache = 0;
let cacheUntil = 0;
let refresh: Promise<number> | null = null;

async function queueBacklog(): Promise<number> {
    if (Date.now() < cacheUntil) return backlogCache;
    if (refresh) return refresh;

    refresh = (async () => {
        const groups = await redis.xinfo("GROUPS", STREAM) as unknown as
            Array<Array<string | number | null>>;
        const row = groups.find((entry) => {
            const f: Fields = {};
            for (let i = 0; i + 1 < entry.length; i += 2) {
                f[String(entry[i])] = String(entry[i + 1] ?? "");
            }
            return f.name === GROUP;
        });
        const f: Fields = {};
        if (row) {
            for (let i = 0; i + 1 < row.length; i += 2) {
                f[String(row[i])] = String(row[i + 1] ?? "");
            }
        }
        backlogCache = Number(f.lag ?? 0) + Number(f.pending ?? 0);
        cacheUntil = Date.now() + 500;
        return backlogCache;
    })().finally(() => { refresh = null; });

    return refresh;
}

export type Admission =
    | { allowed: true; backlog: number }
    | { allowed: false; reason: "user_rate_limit" | "queue_backpressure"; retryAfterMs: number; backlog: number };

export async function admitOrderRequest(userId: string): Promise<Admission> {
    const backlog = await queueBacklog();
    if (backlog >= MAX_BACKLOG) {
        return { allowed: false, reason: "queue_backpressure", retryAfterMs: 1000, backlog };
    }

    const result = await redis.eval(
        TOKEN_BUCKET, 1, `cex:rate-limit:orders:${userId}`,
        Date.now(), BURST, REFILL,
    ) as [number | string, number | string];

    if (Number(result[0]) !== 1) {
        return {
            allowed: false,
            reason: "user_rate_limit",
            retryAfterMs: Number(result[1] ?? 1000),
            backlog,
        };
    }
    return { allowed: true, backlog };
}
