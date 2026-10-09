// tests/full-engine-regression.ts
import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { prisma } from "../apps/engine/db";
import { redis } from "../apps/engine/redis";
const API_URL = "http://localhost:3000";
const ORDER_STREAM = "cex:orders";
const CONSUMER_GROUP = "cex-order-engine";
const RECOVERY_IDLE_TIME = 5000;
const TIMEOUT_MS = 15000;
const EPSILON = 1e-8;
type RequestResult = {
    status: number;
    body: any;
};
type TestUser = {
    id: string;
    email: string;
    password: string;
    token: string;
};
type OrderInput = {
    asset: string;
    side: "BUY" | "SELL";
    type: "LIMIT" | "MARKET";
    qty: number;
    price?: number;
};
type OrderStatus = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
let consumer: ChildProcess | null = null;
// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------
function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}
function assertClose(actual: number, expected: number, message: string, tolerance = EPSILON): void {
    assert(Math.abs(actual - expected) <= tolerance, `${message}. Expected ${expected}, got ${actual}`);
}
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function request(path: string, options: RequestInit = {}, token?: string): Promise<RequestResult> {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    if (token) {
        headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(`${API_URL}${path}`, {
        ...options,
        headers,
    });
    const text = await response.text();
    let body: any;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = text;
    }
    return {
        status: response.status,
        body,
    };
}
// --------------------------------------------------
// USER AND BALANCE HELPERS
// --------------------------------------------------
async function createUser(): Promise<TestUser> {
    const email = `regression-${randomUUID()}@example.com`;
    const password = `Test-${randomUUID()}-Password`;
    const response = await request("/users", {
        method: "POST",
        body: JSON.stringify({
            email,
            password,
        }),
    });
    assert(response.status === 201, `User creation failed: ${JSON.stringify(response.body)}`);
    assert(typeof response.body.id === "string", "User creation did not return a user ID");
    const loginResponse = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({
            email,
            password,
        }),
    });
    assert(loginResponse.status === 200, `Login failed: ${JSON.stringify(loginResponse.body)}`);
    assert(typeof loginResponse.body.token === "string", "Login did not return a token");
    return {
        id: response.body.id,
        email,
        password,
        token: loginResponse.body.token,
    };
}
async function createBalance(user: TestUser, asset: string, amount: number): Promise<void> {
    const response = await request(`/users/${user.id}/balances`, {
        method: "POST",
        body: JSON.stringify({
            asset,
            amount,
        }),
    }, user.token);
    assert(response.status === 201, `Balance creation failed for ${asset}: ${JSON.stringify(response.body)}`);
}
async function getBalance(userId: string, asset: string) {
    return prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId,
                asset,
            },
        },
    });
}
async function requireBalance(userId: string, asset: string) {
    const balance = await getBalance(userId, asset);
    assert(balance !== null, `Missing ${asset} balance for user ${userId}`);
    return balance;
}
// --------------------------------------------------
// ORDER HELPERS
// --------------------------------------------------
async function createOrder(user: TestUser, input: OrderInput): Promise<string> {
    const response = await request("/orders", {
        method: "POST",
        body: JSON.stringify(input),
    }, user.token);
    assert(response.status === 201, `Order submission failed: ${JSON.stringify(response.body)}`);
    assert(typeof response.body.orderId === "string", "Order submission did not return orderId");
    return response.body.orderId;
}
async function getOrder(orderId: string) {
    return prisma.order.findUnique({
        where: {
            id: orderId,
        },
    });
}
async function waitForOrderStatus(orderId: string, expectedStatus: OrderStatus, timeoutMs = TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const order = await getOrder(orderId);
        if (order?.status === expectedStatus) {
            return order;
        }
        await sleep(200);
    }
    const finalOrder = await getOrder(orderId);
    throw new Error(`Timed out waiting for order ${orderId}. ` +
        `Expected status=${expectedStatus}; ` +
        `actual status=${finalOrder?.status ?? "NOT_FOUND"}, ` +
        `remainingQty=${finalOrder?.remainingQty ?? "N/A"}`);
}
/**

 * Wait for BOTH the expected status and remaining quantity.

 *

 * This prevents a test from passing its wait condition after

 * only the first of multiple partial fills.

 */
async function waitForOrderRemainingQty(orderId: string, expectedStatus: OrderStatus, expectedRemainingQty: number, timeoutMs = TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const order = await getOrder(orderId);
        if (order &&
            order.status === expectedStatus &&
            Math.abs(Number(order.remainingQty) -
                expectedRemainingQty) < EPSILON) {
            return order;
        }
        await sleep(200);
    }
    const finalOrder = await getOrder(orderId);
    throw new Error(`Timed out waiting for order ${orderId}: ` +
        `expected status=${expectedStatus}, ` +
        `remaining=${expectedRemainingQty}; ` +
        `actual status=${finalOrder?.status ?? "NOT_FOUND"}, ` +
        `remaining=${finalOrder?.remainingQty ?? "N/A"}`);
}
type TradeWhereInput = any;
async function waitForTradeCount(where: TradeWhereInput, expectedCount: number, timeoutMs = TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const count = await prisma.trade.count({
            where,
        });
        if (count === expectedCount) {
            return;
        }
        await sleep(200);
    }
    const actual = await prisma.trade.count({
        where,
    });
    throw new Error(`Timed out waiting for ${expectedCount} trades; got ${actual}`);
}
async function waitForRedisMessageAcknowledged(messageId: string, timeoutMs = TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pending = (await redis.xpending(ORDER_STREAM, CONSUMER_GROUP, "-", "+", 100)) as Array<[
            string,
            string,
            number,
            string
        ]>;
        if (!pending.some((entry) => entry[0] === messageId)) {
            return;
        }
        await sleep(200);
    }
    throw new Error(`Redis message ${messageId} was not acknowledged in time`);
}
// --------------------------------------------------
// REDIS CONSUMER HELPERS
// --------------------------------------------------
async function ensureConsumerGroup(): Promise<void> {
    try {
        await redis.xgroup("CREATE", ORDER_STREAM, CONSUMER_GROUP, "0", "MKSTREAM");
    }
    catch (error: unknown) {
        if (error instanceof Error &&
            error.message.includes("BUSYGROUP")) {
            return;
        }
        throw error;
    }
}
function startConsumer(): ChildProcess {
    console.log("\nStarting Redis order consumer...");
    const child = spawn("bun", [
        "run",
        "apps/engine/redis-order-consumer.ts",
    ], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data: Buffer) => {
        process.stdout.write(`[CONSUMER] ${data.toString()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
        process.stderr.write(`[CONSUMER ERROR] ${data.toString()}`);
    });
    child.on("error", (error: Error) => {
        console.error("Consumer process error:", error);
    });
    return child;
}
async function stopConsumer(): Promise<void> {
    const child = consumer;
    consumer = null;
    if (!child || child.exitCode !== null) {
        return;
    }
    child.kill();
    await Promise.race([
        new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
        }),
        sleep(2000),
    ]);
}
async function waitForConsumerStartup(): Promise<void> {
    // Give the consumer time to create/check its group and start polling.
    await sleep(1500);
    assert(consumer !== null && consumer.exitCode === null, "Redis consumer exited during startup");
}
async function addPendingOrder(
    orderId: string,
    userId: string,
    side: "BUY" | "SELL",
    qty: number,
    price: number,
    asset = "ETH",
): Promise<string> {
    const messageId = await redis.xadd(
        ORDER_STREAM,
        "*",
        "orderId", orderId,
        "userId", userId,
        "asset", asset,
        "side", side,
        "type", "LIMIT",
        "qty", String(qty),
        "price", String(price),
    );
    assert(typeof messageId === "string", `Failed to add pending ${side} order to Redis`);
    return messageId;
}
async function deliverToFakeConsumer(expectedMessageIds: string[]): Promise<void> {
    const result = await redis.xreadgroup("GROUP", CONSUMER_GROUP, `regression-crash-${randomUUID()}`, "COUNT", expectedMessageIds.length, "BLOCK", 1000, "STREAMS", ORDER_STREAM, ">");
    assert(result !== null && result.length > 0, "Fake crashed consumer did not receive Redis messages");
    const receivedIds = new Set<string>();
    for (const [, messages] of result as any) {
        for (const [messageId] of messages) {
            receivedIds.add(messageId);
        }
    }
    for (const expectedId of expectedMessageIds) {
        assert(receivedIds.has(expectedId), `Fake consumer did not receive message ${expectedId}`);
    }
}
async function waitForMessagesPending(expectedMessageIds: string[]): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 5000) {
        const pending = (await redis.xpending(ORDER_STREAM, CONSUMER_GROUP, "-", "+", 100)) as Array<[
            string,
            string,
            number,
            string
        ]>;
        const pendingIds = new Set(pending.map((entry) => entry[0]));
        if (expectedMessageIds.every((id) => pendingIds.has(id))) {
            return;
        }
        await sleep(100);
    }
    throw new Error("Not all recovery-test messages became pending");
}
// --------------------------------------------------
// TEST 1: MULTIPLE PARTIAL FILLS
// --------------------------------------------------
async function testMultiplePartialFills(): Promise<void> {
    console.log("\n[1/8] Multiple partial fills");
    const buyer = await createUser();
    const seller1 = await createUser();
    const seller2 = await createUser();
    await createBalance(buyer, "USDT", 5000);
    await createBalance(seller1, "XRP", 0.4);
    await createBalance(seller2, "XRP", 0.3);
    const sell1Id = await createOrder(seller1, {
        asset: "XRP",
        side: "SELL",
        type: "LIMIT",
        qty: 0.4,
        price: 2000,
    });
    const sell2Id = await createOrder(seller2, {
        asset: "XRP",
        side: "SELL",
        type: "LIMIT",
        qty: 0.3,
        price: 2000,
    });
    await waitForOrderStatus(sell1Id, "OPEN");
    await waitForOrderStatus(sell2Id, "OPEN");
    const buyId = await createOrder(buyer, {
        asset: "XRP",
        side: "BUY",
        type: "LIMIT",
        qty: 1,
        price: 2000,
    });
    // Wait for both SELL orders to be completely filled.
    await waitForOrderStatus(sell1Id, "FILLED");
    await waitForOrderStatus(sell2Id, "FILLED");
    // Do not stop at the first partial fill: wait for the final 0.3 remaining.
    const buyOrder = await waitForOrderRemainingQty(buyId, "PARTIALLY_FILLED", 0.3);
    assertClose(Number(buyOrder.remainingQty), 0.3, "BUY remaining quantity after both fills");
    const trades = await prisma.trade.findMany({
        where: {
            OR: [
                { buyOrderId: buyId },
                { sellOrderId: sell1Id },
                { sellOrderId: sell2Id },
            ],
        },
    });
    assert(trades.length === 2, `Expected 2 partial-fill trades, got ${trades.length}`);
    const filledQty = trades.reduce((total, trade) => total + Number(trade.quantity), 0);
    assertClose(filledQty, 0.7, "Total partial-fill quantity");
    const buyerUSDT = await requireBalance(buyer.id, "USDT");
    const buyerXRP = await requireBalance(buyer.id, "XRP");
    assertClose(Number(buyerUSDT.available), 3000, "Buyer USDT available after partial fills");
    assertClose(Number(buyerUSDT.locked), 600, "Buyer USDT locked for unfilled quantity");
    assertClose(Number(buyerXRP.available), 0.7, "Buyer XRP received");
    console.log("✅ Multiple partial fills passed");
}
// --------------------------------------------------
// TEST 2: MARKET BUY
// --------------------------------------------------
async function testMarketBuy(): Promise<void> {
    console.log("\n[2/8] Market BUY");
    const buyer = await createUser();
    const seller1 = await createUser();
    const seller2 = await createUser();
    await createBalance(buyer, "USDT", 2000);
    await createBalance(seller1, "BTC", 0.4);
    await createBalance(seller2, "BTC", 0.6);
    const sell1Id = await createOrder(seller1, {
        asset: "BTC",
        side: "SELL",
        type: "LIMIT",
        qty: 0.4,
        price: 1000,
    });
    const sell2Id = await createOrder(seller2, {
        asset: "BTC",
        side: "SELL",
        type: "LIMIT",
        qty: 0.6,
        price: 1100,
    });
    await waitForOrderStatus(sell1Id, "OPEN");
    await waitForOrderStatus(sell2Id, "OPEN");
    const buyId = await createOrder(buyer, {
        asset: "BTC",
        side: "BUY",
        type: "MARKET",
        qty: 0.7,
    });
    const buyOrder = await waitForOrderStatus(buyId, "FILLED");
    await waitForTradeCount({ buyOrderId: buyId }, 2);
    assertClose(Number(buyOrder.remainingQty), 0, "Market BUY remaining quantity");
    const trades = await prisma.trade.findMany({
        where: {
            buyOrderId: buyId,
        },
        orderBy: {
            createdAt: "asc",
        },
    });
    assert(trades.length === 2, "Market BUY should create two fills");
    const firstFill = trades.find((trade) => trade.sellOrderId === sell1Id);
    const secondFill = trades.find((trade) => trade.sellOrderId === sell2Id);
    assert(firstFill !== undefined, "Market BUY did not consume the best ask");
    assert(secondFill !== undefined, "Market BUY did not consume the second ask");
    assertClose(Number(firstFill.quantity), 0.4, "First market BUY fill");
    assertClose(Number(firstFill.price), 1000, "First market BUY price");
    assertClose(Number(secondFill.quantity), 0.3, "Second market BUY fill");
    assertClose(Number(secondFill.price), 1100, "Second market BUY price");
    const buyerUSDT = await requireBalance(buyer.id, "USDT");
    const buyerBTC = await requireBalance(buyer.id, "BTC");
    assertClose(Number(buyerUSDT.available), 1270, "Market BUY buyer USDT available");
    assertClose(Number(buyerUSDT.locked), 0, "Market BUY buyer USDT locked");
    assertClose(Number(buyerBTC.available), 0.7, "Market BUY buyer BTC received");
    // Implementations may store an exhausted reservation as NULL or zero.
    const reservation = buyOrder.marketBuyReservedUSDT;
    assert(reservation === null ||
        Math.abs(Number(reservation)) < EPSILON, `Expected exhausted market BUY reservation, got ${reservation}`);
    console.log("✅ Market BUY passed");
}
// --------------------------------------------------
// TEST 3: MARKET SELL
// --------------------------------------------------
async function testMarketSell(): Promise<void> {
    console.log("\n[3/8] Market SELL");
    const seller = await createUser();
    const buyer1 = await createUser();
    const buyer2 = await createUser();
    await createBalance(seller, "SOL", 0.9);
    await createBalance(buyer1, "USDT", 400);
    await createBalance(buyer2, "USDT", 450);
    const buy1Id = await createOrder(buyer1, {
        asset: "SOL",
        side: "BUY",
        type: "LIMIT",
        qty: 0.4,
        price: 1000,
    });
    const buy2Id = await createOrder(buyer2, {
        asset: "SOL",
        side: "BUY",
        type: "LIMIT",
        qty: 0.5,
        price: 900,
    });
    await waitForOrderStatus(buy1Id, "OPEN");
    await waitForOrderStatus(buy2Id, "OPEN");
    const sellId = await createOrder(seller, {
        asset: "SOL",
        side: "SELL",
        type: "MARKET",
        qty: 0.9,
    });
    const sellOrder = await waitForOrderStatus(sellId, "FILLED");
    assertClose(Number(sellOrder.remainingQty), 0, "Market SELL remaining quantity after full execution");
    await waitForTradeCount({ sellOrderId: sellId }, 2);
    const trades = await prisma.trade.findMany({
        where: {
            sellOrderId: sellId,
        },
    });
    const soldQty = trades.reduce((total, trade) => total + Number(trade.quantity), 0);
    assertClose(soldQty, 0.9, "Market SELL total filled quantity");
    const sellerSOL = await requireBalance(seller.id, "SOL");
    const sellerUSDT = await requireBalance(seller.id, "USDT");
    assertClose(Number(sellerSOL.available), 0, "Market SELL seller SOL available");
    assertClose(Number(sellerSOL.locked), 0, "Market SELL seller SOL locked");
    assertClose(Number(sellerUSDT.available), 850, "Market SELL seller USDT received");
    console.log("✅ Market SELL passed");
}
// --------------------------------------------------
// TEST 4: PRICE-TIME PRIORITY
// --------------------------------------------------
async function testPriceTimePriority(): Promise<void> {
    console.log("\n[4/8] Price-time priority");
    const buyer = await createUser();
    const firstSeller = await createUser();
    const secondSeller = await createUser();
    await createBalance(buyer, "USDT", 1000);
    await createBalance(firstSeller, "ETH", 0.4);
    await createBalance(secondSeller, "ETH", 0.4);
    const firstSellId = await createOrder(firstSeller, {
        asset: "ETH",
        side: "SELL",
        type: "LIMIT",
        qty: 0.4,
        price: 1000,
    });
    await waitForOrderStatus(firstSellId, "OPEN");
    // Submit the second order later at the same price.
    const secondSellId = await createOrder(secondSeller, {
        asset: "ETH",
        side: "SELL",
        type: "LIMIT",
        qty: 0.4,
        price: 1000,
    });
    await waitForOrderStatus(secondSellId, "OPEN");
    const buyId = await createOrder(buyer, {
        asset: "ETH",
        side: "BUY",
        type: "LIMIT",
        qty: 0.7,
        price: 1000,
    });
    await waitForOrderStatus(firstSellId, "FILLED");
    await waitForOrderRemainingQty(secondSellId, "PARTIALLY_FILLED", 0.1);
    await waitForOrderStatus(buyId, "FILLED");
    const firstTrade = await prisma.trade.findFirst({
        where: {
            buyOrderId: buyId,
            sellOrderId: firstSellId,
        },
    });
    const secondTrade = await prisma.trade.findFirst({
        where: {
            buyOrderId: buyId,
            sellOrderId: secondSellId,
        },
    });
    assert(firstTrade !== null, "Older same-price SELL was not matched");
    assert(secondTrade !== null, "Newer same-price SELL was not matched");
    assertClose(Number(firstTrade.quantity), 0.4, "Older SELL fill quantity");
    assertClose(Number(secondTrade.quantity), 0.3, "Newer SELL fill quantity");
    console.log("✅ Price-time priority passed");
}
// --------------------------------------------------
// TEST 5: CANCELLATION AND UNLOCKING
// --------------------------------------------------
async function testCancellation(): Promise<void> {
    console.log("\n[5/8] Cancellation and balance unlocking");
    const buyer = await createUser();
    await createBalance(buyer, "USDT", 1000);
    const orderId = await createOrder(buyer, {
        asset: "XRP",
        side: "BUY",
        type: "LIMIT",
        qty: 0.5,
        price: 1000,
    });
    await waitForOrderStatus(orderId, "OPEN");
    const balanceBefore = await requireBalance(buyer.id, "USDT");
    assertClose(Number(balanceBefore.available), 500, "USDT available before cancellation");
    assertClose(Number(balanceBefore.locked), 500, "USDT locked before cancellation");
    const cancelResponse = await request(`/orders/${orderId}`, {
        method: "DELETE",
    }, buyer.token);
    assert(cancelResponse.status === 200, `Cancellation request failed: ${JSON.stringify(cancelResponse.body)}`);
    await waitForOrderStatus(orderId, "CANCELLED");
    const cancelledOrder = await getOrder(orderId);
    assert(cancelledOrder !== null, "Cancelled order not found");
    assertClose(Number(cancelledOrder.remainingQty), 0.5, "Cancelled order remaining quantity");
    const balanceAfter = await requireBalance(buyer.id, "USDT");
    assertClose(Number(balanceAfter.available), 1000, "USDT available after cancellation");
    assertClose(Number(balanceAfter.locked), 0, "USDT locked after cancellation");
    console.log("✅ Cancellation and unlocking passed");
}
// --------------------------------------------------
// TEST 6: REDIS RECOVERY AND IDEMPOTENCY
// --------------------------------------------------
async function testRedisRecoveryAndIdempotency(): Promise<void> {
    console.log("\n[6/8] Redis recovery and idempotency");
    const buyer = await createUser();
    const seller = await createUser();
    const idempotencyAsset = "IDEMPOTENCYTEST";
    await createBalance(buyer, "USDT", 5000);
    await createBalance(seller, idempotencyAsset, 1);
    // First verify idempotency using a normally processed trade.
    const sellId = await createOrder(seller, {
        asset: idempotencyAsset,
        side: "SELL",
        type: "LIMIT",
        qty: 1,
        price: 2000,
    });
    await waitForOrderStatus(sellId, "OPEN");
    const buyId = await createOrder(buyer, {
        asset: idempotencyAsset,
        side: "BUY",
        type: "LIMIT",
        qty: 1,
        price: 2000,
    });
    await waitForOrderStatus(buyId, "FILLED");
    await waitForOrderStatus(sellId, "FILLED");
    await waitForTradeCount({
        OR: [
            { buyOrderId: buyId },
            { sellOrderId: sellId },
        ],
    }, 1);
    const originalTradeCount = await prisma.trade.count({
        where: {
            OR: [
                { buyOrderId: buyId },
                { sellOrderId: sellId },
            ],
        },
    });
    assert(originalTradeCount === 1, `Expected one original trade, got ${originalTradeCount}`);
    // Re-submit the same BUY order ID directly through Redis.
    const duplicateMessageId = await redis.xadd(ORDER_STREAM, "*", "orderId", buyId, "userId", buyer.id, "asset", idempotencyAsset, "side", "BUY", "type", "LIMIT", "qty", "1", "price", "2000");
    assert(typeof duplicateMessageId === "string", "Could not publish duplicate Redis message");
    await waitForRedisMessageAcknowledged(duplicateMessageId);
    const afterDuplicateCount = await prisma.trade.count({
        where: {
            OR: [
                { buyOrderId: buyId },
                { sellOrderId: sellId },
            ],
        },
    });
    assert(afterDuplicateCount === 1, `Duplicate message created an extra trade: ${afterDuplicateCount}`);
    console.log("  ✅ Duplicate order message did not create another trade");
    // Now test recovery of messages left pending by a crashed consumer.
    // Stop our consumer before assigning messages to the fake consumer.
    await stopConsumer();
    const recoveryBuyer = await createUser();
    const recoverySeller = await createUser();
    const recoveryAsset = "RECOVERYTEST";

    await createBalance(recoveryBuyer, "USDT", 5000);
    await createBalance(recoverySeller, recoveryAsset, 1);

    const recoveryBuyId = randomUUID();
    const recoverySellId = randomUUID();

    const buyMessageId = await addPendingOrder(
        recoveryBuyId,
        recoveryBuyer.id,
        "BUY",
        1,
        2000,
        recoveryAsset,
    );

    const sellMessageId = await addPendingOrder(
        recoverySellId,
        recoverySeller.id,
        "SELL",
        1,
        2000,
        recoveryAsset,
    );
    await deliverToFakeConsumer([
        buyMessageId,
        sellMessageId,
    ]);
    await waitForMessagesPending([
        buyMessageId,
        sellMessageId,
    ]);
    console.log(`  Waiting ${RECOVERY_IDLE_TIME + 1000}ms for pending messages to become recoverable...`);
    await sleep(RECOVERY_IDLE_TIME + 1000);
    consumer = startConsumer();
    await waitForConsumerStartup();
    await waitForOrderStatus(recoveryBuyId, "FILLED");
    await waitForOrderStatus(recoverySellId, "FILLED");
    await waitForTradeCount({
        OR: [
            { buyOrderId: recoveryBuyId },
            { sellOrderId: recoverySellId },
        ],
    }, 1);
    await waitForRedisMessageAcknowledged(buyMessageId);
    await waitForRedisMessageAcknowledged(sellMessageId);
    const recoveryTradeCount = await prisma.trade.count({
        where: {
            OR: [
                { buyOrderId: recoveryBuyId },
                { sellOrderId: recoverySellId },
            ],
        },
    });
    assert(recoveryTradeCount === 1, `Recovery should create exactly one trade, got ${recoveryTradeCount}`);
    const recoveryBuyerUSDT = await requireBalance(recoveryBuyer.id, "USDT");
    const recoveryBuyerAsset = await requireBalance(
        recoveryBuyer.id,
        recoveryAsset,
    );
    const recoverySellerUSDT = await requireBalance(recoverySeller.id, "USDT");
    const recoverySellerAsset = await requireBalance(
        recoverySeller.id,
        recoveryAsset,
    );

    assertClose(Number(recoveryBuyerUSDT.available), 3000, "Recovery buyer USDT available");
    assertClose(Number(recoveryBuyerUSDT.locked), 0, "Recovery buyer USDT locked");
    assertClose(Number(recoveryBuyerAsset.available), 1, "Recovery buyer asset received");
    assertClose(Number(recoverySellerUSDT.available), 2000, "Recovery seller USDT received");
    assertClose(Number(recoverySellerAsset.available), 0, "Recovery seller asset available");
    assertClose(Number(recoverySellerAsset.locked), 0, "Recovery seller asset locked");
    console.log("  ✅ Pending Redis messages recovered");
    console.log("  ✅ Recovered messages acknowledged");
    console.log("  ✅ Recovery settlement passed");
    console.log("✅ Redis recovery and idempotency passed");
}
// --------------------------------------------------
// TEST 7: CONCURRENT ORDERS / RACE CONDITIONS
// --------------------------------------------------

async function testConcurrentOrders(): Promise<void> {
    console.log("\n[7/8] Concurrent orders and race conditions");

    const seller = await createUser();
    const buyer1 = await createUser();
    const buyer2 = await createUser();

    // Isolate this test from stale BTC orders.
    const concurrentAsset = "CONCURRENCYTEST";

    await createBalance(seller, concurrentAsset, 1);
    await createBalance(buyer1, "USDT", 2000);
    await createBalance(buyer2, "USDT", 2000);

    const sellId = await createOrder(seller, {
        asset: concurrentAsset,
        side: "SELL",
        type: "LIMIT",
        qty: 1,
        price: 1500,
    });

    await waitForOrderStatus(sellId, "OPEN");

    // Submit both BUY orders concurrently.
    const [buy1Id, buy2Id] = await Promise.all([
        createOrder(buyer1, {
            asset: concurrentAsset,
            side: "BUY",
            type: "LIMIT",
            qty: 0.6,
            price: 1500,
        }),
        createOrder(buyer2, {
            asset: concurrentAsset,
            side: "BUY",
            type: "LIMIT",
            qty: 0.6,
            price: 1500,
        }),
    ]);

    // The seller has only 1 unit available, despite 1.2 units
    // of total BUY demand. Both BUYs must not oversell it.
    await waitForOrderStatus(sellId, "FILLED");
    await waitForTradeCount({ sellOrderId: sellId }, 2);

    const trades = await prisma.trade.findMany({
        where: {
            sellOrderId: sellId,
        },
    });

    assert(
        trades.length === 2,
        `Expected 2 concurrent-order trades, got ${trades.length}`,
    );

    const totalFilled = trades.reduce(
        (total, trade) => total + Number(trade.quantity),
        0,
    );

    assertClose(
        totalFilled,
        1,
        "Concurrent orders must not oversell available quantity",
    );

    const buy1Order = await getOrder(buy1Id);
    const buy2Order = await getOrder(buy2Id);

    assert(
        buy1Order !== null,
        "First concurrent BUY order not found",
    );
    assert(
        buy2Order !== null,
        "Second concurrent BUY order not found",
    );

    assert(
        ["FILLED", "PARTIALLY_FILLED"].includes(buy1Order.status),
        `Unexpected first BUY status: ${buy1Order.status}`,
    );

    assert(
        ["FILLED", "PARTIALLY_FILLED"].includes(buy2Order.status),
        `Unexpected second BUY status: ${buy2Order.status}`,
    );

    const sellerAsset = await requireBalance(
        seller.id,
        concurrentAsset,
    );

    const sellerUSDT = await requireBalance(
        seller.id,
        "USDT",
    );

    assertClose(
        Number(sellerAsset.available),
        0,
        "Concurrent test seller asset available",
    );

    assertClose(
        Number(sellerAsset.locked),
        0,
        "Concurrent test seller asset locked",
    );

    assertClose(
        Number(sellerUSDT.available),
        1500,
        "Concurrent test seller USDT received",
    );

    console.log("✅ Concurrent orders and race-condition test passed");
}

// --------------------------------------------------
// TEST 8: END-TO-END REGRESSION
// --------------------------------------------------
async function testEndToEndRegression(): Promise<void> {
    console.log("\n[8/8] Final end-to-end regression");
    const buyer = await createUser();
    const seller = await createUser();
    await createBalance(buyer, "USDT", 5000);
    await createBalance(seller, "XRP", 1);
    const sellId = await createOrder(seller, {
        asset: "XRP",
        side: "SELL",
        type: "LIMIT",
        qty: 0.5,
        price: 2500,
    });
    await waitForOrderStatus(sellId, "OPEN");
    const buyId = await createOrder(buyer, {
        asset: "XRP",
        side: "BUY",
        type: "LIMIT",
        qty: 0.5,
        price: 2500,
    });
    await waitForOrderStatus(buyId, "FILLED");
    await waitForOrderStatus(sellId, "FILLED");
    await waitForTradeCount({
        OR: [
            { buyOrderId: buyId },
            { sellOrderId: sellId },
        ],
    }, 1);
    const trades = await prisma.trade.findMany({
        where: {
            buyOrderId: buyId,
            sellOrderId: sellId,
        },
    });
    assert(trades.length === 1, "E2E should create exactly one trade");
    assertClose(Number(trades[0]!.quantity), 0.5, "E2E trade quantity");
    assertClose(Number(trades[0]!.price), 2500, "E2E trade price");
    const buyerUSDT = await requireBalance(buyer.id, "USDT");
    const buyerXRP = await requireBalance(buyer.id, "XRP");
    const sellerUSDT = await requireBalance(seller.id, "USDT");
    const sellerXRP = await requireBalance(seller.id, "XRP");
    assertClose(Number(buyerUSDT.available), 3750, "E2E buyer USDT available");
    assertClose(Number(buyerUSDT.locked), 0, "E2E buyer USDT locked");
    assertClose(Number(buyerXRP.available), 0.5, "E2E buyer XRP received");
    assertClose(Number(buyerXRP.locked), 0, "E2E buyer XRP locked");
    assertClose(Number(sellerUSDT.available), 1250, "E2E seller USDT received");
    assertClose(Number(sellerUSDT.locked), 0, "E2E seller USDT locked");
    assertClose(Number(sellerXRP.available), 0.5, "E2E seller XRP remaining");
    assertClose(Number(sellerXRP.locked), 0, "E2E seller XRP locked");
    // Verify the REST API can retrieve each user's own order.
    const buyerOrderResponse = await request(`/orders/${buyId}`, {}, buyer.token);
    assert(buyerOrderResponse.status === 200, `E2E buyer order endpoint failed: ${JSON.stringify(buyerOrderResponse.body)}`);
    assert(buyerOrderResponse.body.id === buyId, "E2E buyer order endpoint returned the wrong order");
    const sellerOrderResponse = await request(`/orders/${sellId}`, {}, seller.token);
    assert(sellerOrderResponse.status === 200, `E2E seller order endpoint failed: ${JSON.stringify(sellerOrderResponse.body)}`);
    assert(sellerOrderResponse.body.id === sellId, "E2E seller order endpoint returned the wrong order");
    // Verify a different user cannot read the buyer's order.
    const unauthorizedResponse = await request(`/orders/${buyId}`, {}, seller.token);
    assert(unauthorizedResponse.status === 404, `Expected cross-user order access to return 404, got ${unauthorizedResponse.status}`);
    console.log("✅ Final end-to-end regression passed");
}
// --------------------------------------------------
// MAIN TEST RUNNER
// --------------------------------------------------
async function main(): Promise<void> {
    try {
        console.log("==============================================");
        console.log("       CEX V2 FULL ENGINE REGRESSION");
        console.log("==============================================");
        // Fail early if the API is not running.
        const health = await request("/");
        assert(health.status === 200, `Backend health check failed: HTTP ${health.status}`);
        console.log("✅ Backend is reachable");
        await ensureConsumerGroup();
        consumer = startConsumer();
        await waitForConsumerStartup();
        await testMultiplePartialFills();
        await testMarketBuy();
        await testMarketSell();
        await testPriceTimePriority();
        await testCancellation();
        await testRedisRecoveryAndIdempotency();
        await testConcurrentOrders();
        await testEndToEndRegression();
        console.log("\n==============================================");
        console.log("       ✅ ALL 8 REGRESSION TESTS PASSED");
        console.log("==============================================");
    }
    finally {
        await stopConsumer();
        await prisma.$disconnect();
        redis.disconnect();
    }
}
main().catch((error: unknown) => {
    console.error("\n==============================================");
    console.error("       ❌ CEX V2 REGRESSION TEST FAILED");
    console.error("==============================================");
    console.error(error);
    process.exit(1);
});

