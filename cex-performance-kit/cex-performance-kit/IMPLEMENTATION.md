# CEX V2 Performance Kit

These are **local files for manual integration**; nothing has been changed on GitHub.

## Goals and phases

1. Measure throughput and latency automatically.
2. Remove per-order debug logs and instrument expensive database operations.
3. Add per-user admission control and global queue backpressure.
4. Use the benchmark to establish a baseline.
5. Add bounded per-asset concurrency as a separate, regression-tested change. Do not use an unbounded `Promise.all()` on the existing consumer: cancellation events, matching priority, and shared USDT balance rows require coordinated ordering.

## 1. Copy files
Copy the included `apps/backend/order-admission.ts`, `apps/engine/metrics.ts`, and `load-tests/benchmark.ts` into those paths in your local repo.

## 2. Add admission control to `apps/backend/index.ts`
Inside authenticated `POST /orders`, after `userId` and request validation are known but **before** adding to Redis, add this import:
```ts
import { admitOrderRequest } from "./order-admission";
```
Then:
```ts
const admission = await admitOrderRequest(userId);
if (!admission.allowed) {
    const status = admission.reason === "user_rate_limit" ? 429 : 503;
    return Response.json(
        {
            error: admission.reason === "user_rate_limit"
                ? "Order rate limit exceeded"
                : "Order queue is overloaded",
            retryAfterMs: admission.retryAfterMs,
            backlog: admission.backlog,
        },
        {
            status,
            headers: {
                "Retry-After": String(Math.max(1, Math.ceil(admission.retryAfterMs / 1000))),
            },
        },
    );
}
```
Adapt only the variable name/response helper if your current route differs.

Environment variables:
- `ORDER_RATE_BURST=10` (per-user burst capacity)
- `ORDER_RATE_PER_SECOND=5` (per-user refill)
- `MAX_ORDER_BACKLOG=50000` (global queue threshold)

The earlier queue backlog was ~235,000, so this default deliberately returns 503 to all new order submissions until the existing queue falls below 50,000. The user-specific 429 applies only to the user who exceeds their own limit. A 503 is global overload protection.

A per-user rate limiter stops one user flooding the queue; it does not slow orders that are already enqueued. To prioritize other users over an abusive user's existing queued orders, the architecture would need per-user queues or a fair scheduler.

## 3. Add consumer processing metrics
In `apps/engine/redis-order-consumer.ts`, import:
```ts
import { recordOrderFailed, recordOrderProcessed } from "./metrics";
```
Rename the existing `processOrderMessage` function to `processOrderMessageInternal` without changing its body. Then add this wrapper after it:
```ts
async function processOrderMessage(messageId: string, fields: string[]): Promise<void> {
    const startedAt = performance.now();
    try {
        await processOrderMessageInternal(messageId, fields);
        recordOrderProcessed(performance.now() - startedAt);
    } catch (error) {
        recordOrderFailed();
        throw error;
    }
}
```
Keep existing callers named `processOrderMessage`, so normal reads and recovery both use the wrapper. ACK must remain after successful processing.

## 4. Instrument selected DB operations
In `apps/engine/submit-order.ts`, import `measureDbOperation` and wrap the existing `createOrderInDb(...)` call:
```ts
const order = await measureDbOperation(() =>
    createOrderInDb(id, userId, asset, side, type, qty, price)
);
```
In `apps/engine/orderbook-db.ts`, import `measureDbOperation` and wrap `getBestAsk`/`getBestBid` `prisma.order.findFirst(...)` calls and the `findMany(...)` inside `calculateMarketBuyRequiredUSDT`.
In `apps/engine/matcher.ts`, import `measureDbOperation` and wrap the whole `prisma.$transaction(...)` call. Keep the transaction body/options unchanged.
These are key DB operations/transactions, not every Prisma SQL statement.

Remove noisy per-match logs from `matching-engine.ts` and the temporary `MATCHER TRADE CREATED` log from `matcher.ts`; keep error logs and status/trade events.

## 5. Run the benchmark (Windows-friendly, interactive login)
Use dedicated test accounts, not real users. The script now prompts for the asset and automatically logs in as seller and buyer through your existing `POST /auth/login` endpoint; it keeps returned JWTs in memory, so you do not need to set token variables manually.
- Seller needs available balance in the selected `ASSET`.
- Buyer needs sufficient USDT.
- The two accounts must be different, registered test users.

Start the engine and backend, then run from the repo root:
```bat
bun run load-tests/benchmark.ts
```
The script prompts for seller and buyer email/password and the asset symbol. Defaults are 30 seconds of load, 10 seconds of drain, concurrency 1, price 1, and quantity 0.001. You can override duration/price/quantity with environment variables if needed. The password is entered in the terminal, so use test-account credentials only. This script does not register users or create/fund balances because those APIs and funding rules are project-specific.
 Each worker submits SELL LIMIT then crossing BUY LIMIT orders. The test automatically reports:
- HTTP accepted requests/s, average and p95 HTTP latency, 429 and 503 counts
- engine successful orders/s and failed processing attempts
- average end-to-end processing time
- average latency of instrumented DB operations
- queue lag and pending changes

Metrics are process-wide, including any old backlog being drained. Run without other load for a clean baseline. The script imports the existing Redis client and the metrics module, so the engine should be running in the same Redis environment.

## 6. Typecheck
```bash
bun run typecheck
```
Resolve any TS errors before running the benchmark.
