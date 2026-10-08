import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { prisma } from "../apps/engine/db";
import { redis } from "../apps/engine/redis";

const API_URL = "http://localhost:3000";

const ORDER_STREAM = "cex:orders";
const CONSUMER_GROUP = "cex-order-engine";
const CRASH_CONSUMER = `crash-test-${randomUUID()}`;

const RECOVERY_IDLE_TIME = 5000;

type RequestResult = {
    status: number;
    body: any;
};

function assert(
    condition: boolean,
    message: string,
): void {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function wait(ms: number): Promise<void> {
    await new Promise((resolve) =>
        setTimeout(resolve, ms),
    );
}

async function request(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<RequestResult> {
    const headers = new Headers(options.headers);

    headers.set(
        "Content-Type",
        "application/json",
    );

    if (token) {
        headers.set(
            "Authorization",
            `Bearer ${token}`,
        );
    }

    const response = await fetch(
        `${API_URL}${path}`,
        {
            ...options,
            headers,
        },
    );

    const text = await response.text();

    let body: any;

    try {
        body = JSON.parse(text);
    } catch {
        body = text;
    }

    return {
        status: response.status,
        body,
    };
}

async function createUser(
    email: string,
    password: string,
): Promise<{
    id: string;
    email: string;
    password: string;
}> {
    const response = await request(
        "/users",
        {
            method: "POST",
            body: JSON.stringify({
                email,
                password,
            }),
        },
    );

    assert(
        response.status === 201,
        `User creation failed: ${JSON.stringify(
            response.body,
        )}`,
    );

    assert(
        typeof response.body.id === "string",
        "User creation did not return user ID",
    );

    return {
        id: response.body.id,
        email,
        password,
    };
}

async function login(
    email: string,
    password: string,
): Promise<string> {
    const response = await request(
        "/auth/login",
        {
            method: "POST",
            body: JSON.stringify({
                email,
                password,
            }),
        },
    );

    assert(
        response.status === 200,
        `Login failed: ${JSON.stringify(
            response.body,
        )}`,
    );

    assert(
        typeof response.body.token === "string",
        "Login did not return JWT",
    );

    return response.body.token;
}

async function createBalance(
    userId: string,
    token: string,
    asset: string,
    amount: number,
): Promise<void> {
    const response = await request(
        `/users/${userId}/balances`,
        {
            method: "POST",
            body: JSON.stringify({
                asset,
                amount,
            }),
        },
        token,
    );

    assert(
        response.status === 201,
        `Balance creation failed for ${asset}: ${JSON.stringify(
            response.body,
        )}`,
    );
}

async function getBalance(
    userId: string,
    asset: string,
) {
    return prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId,
                asset,
            },
        },
    });
}

async function waitForOrder(
    orderId: string,
    expectedStatus: string,
    timeoutMs = 15000,
) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const order =
            await prisma.order.findUnique({
                where: {
                    id: orderId,
                },
            });

        if (
            order &&
            order.status === expectedStatus
        ) {
            return order;
        }

        await wait(300);
    }

    const order =
        await prisma.order.findUnique({
            where: {
                id: orderId,
            },
        });

    throw new Error(
        `Timed out waiting for ${orderId} to become ${expectedStatus}. ` +
        `Current status: ${order?.status ?? "NOT FOUND"}`,
    );
}

async function ensureConsumerGroup(): Promise<void> {
    try {
        await redis.xgroup(
            "CREATE",
            ORDER_STREAM,
            CONSUMER_GROUP,
            "0",
            "MKSTREAM",
        );
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            error.message.includes("BUSYGROUP")
        ) {
            return;
        }

        throw error;
    }
}

async function addPendingOrder(
    orderId: string,
    userId: string,
    side: "BUY" | "SELL",
): Promise<string> {
    const messageId = await redis.xadd(
        ORDER_STREAM,
        "*",
        "orderId",
        orderId,
        "userId",
        userId,
        "asset",
        "ETH",
        "side",
        side,
        "type",
        "LIMIT",
        "qty",
        "1",
        "price",
        "2000",
    );

    assert(
        typeof messageId === "string",
        `Redis did not return message ID for ${side}`,
    );
    if(messageId===null){
        throw new Error("messageid is null")
    }
    /*
     * Immediately read the message using the fake
     * crashed consumer.
     *
     * We intentionally DO NOT XACK it.
     */

    const result =
        await redis.xreadgroup(
            "GROUP",
            CONSUMER_GROUP,
            CRASH_CONSUMER,
            "COUNT",
            1,
            "STREAMS",
            ORDER_STREAM,
            ">",
        );

    assert(
        result !== null &&
            result.length > 0,
        `Fake consumer did not receive ${side} message`,
    );

    return messageId;
}

async function waitForPending(
    messageId: string,
): Promise<void> {
    const start = Date.now();

    while (
        Date.now() - start <
        3000
    ) {
        const pending =
            (await redis.xpending(
                ORDER_STREAM,
                CONSUMER_GROUP,
                "-",
                "+",
                100,
            )) as Array<
                [
                    string,
                    string,
                    number,
                    string,
                ]
            >;

        const found = pending.some(
            (entry) =>
                entry[0] === messageId &&
                entry[1] === CRASH_CONSUMER,
        );

        if (found) {
            return;
        }

        await wait(100);
    }

    throw new Error(
        `Message ${messageId} did not become pending`,
    );
}

function startRealConsumer(): ChildProcess {
    console.log(
        "\nStarting real Redis consumer...",
    );

    /*
     * Your consumer file starts itself with:
     *
     * consumeOrders();
     *
     * Therefore Bun can execute the file directly.
     */

    const child = spawn(
        "bun",
        [
            "run",
            "apps/engine/redis-order-consumer.ts",
        ],
        {
            cwd: process.cwd(),
            stdio: [
                "ignore",
                "pipe",
                "pipe",
            ],
        },
    );

    child.stdout?.on(
        "data",
        (data: Buffer) => {
            process.stdout.write(
                `[CONSUMER] ${data.toString()}`,
            );
        },
    );

    child.stderr?.on(
        "data",
        (data: Buffer) => {
            process.stderr.write(
                `[CONSUMER ERROR] ${data.toString()}`,
            );
        },
    );

    child.on(
        "error",
        (error: Error) => {
            console.error(
                "Consumer process error:",
                error,
            );
        },
    );

    return child;
}

function stopConsumer(
    child: ChildProcess | null,
): void {
    if (
        child &&
        child.exitCode === null
    ) {
        child.kill();
    }
}

async function main(): Promise<void> {
    let consumer: ChildProcess | null = null;

    try {
        console.log(
            "========================================",
        );
        console.log(
            "       REDIS RECOVERY TEST",
        );
        console.log(
            "========================================",
        );

        /*
         * --------------------------------------------------
         * 1. VERIFY CONSUMER GROUP
         * --------------------------------------------------
         */

        await ensureConsumerGroup();

        console.log(
            "\nRedis consumer group ready:",
            CONSUMER_GROUP,
        );

        /*
         * --------------------------------------------------
         * 2. CREATE UNIQUE USERS
         * --------------------------------------------------
         */

        console.log(
            "\nCreating users...",
        );

        const suffix = randomUUID();

        const buyer = await createUser(
            `redis-recovery-buyer-${suffix}@test.com`,
            "TestPassword123!",
        );

        const seller = await createUser(
            `redis-recovery-seller-${suffix}@test.com`,
            "TestPassword123!",
        );

        const buyerToken = await login(
            buyer.email,
            buyer.password,
        );

        const sellerToken = await login(
            seller.email,
            seller.password,
        );

        console.log(
            "Buyer:",
            buyer.id,
        );

        console.log(
            "Seller:",
            seller.id,
        );

        /*
         * --------------------------------------------------
         * 3. CREATE BALANCES
         * --------------------------------------------------
         */

        await createBalance(
            buyer.id,
            buyerToken,
            "USDT",
            5000,
        );

        await createBalance(
            seller.id,
            sellerToken,
            "ETH",
            2,
        );

        console.log(
            "\nBalances created.",
        );

        /*
         * --------------------------------------------------
         * 4. GENERATE ORDER IDs
         * --------------------------------------------------
         */

        const buyOrderId =
            randomUUID();

        const sellOrderId =
            randomUUID();

        /*
         * --------------------------------------------------
         * 5. PUT BOTH ORDERS INTO PENDING STATE
         * --------------------------------------------------
         *
         * The fake consumer receives both messages.
         *
         * We NEVER acknowledge them.
         *
         * This simulates:
         *
         * consumer receives message
         *        ↓
         * process crashes
         *        ↓
         * message remains pending
         */

        console.log(
            "\nCreating pending BUY message...",
        );

        const buyMessageId =
            await addPendingOrder(
                buyOrderId,
                buyer.id,
                "BUY",
            );

        console.log(
            "BUY Redis message:",
            buyMessageId,
        );

        console.log(
            "\nCreating pending SELL message...",
        );

        const sellMessageId =
            await addPendingOrder(
                sellOrderId,
                seller.id,
                "SELL",
            );

        console.log(
            "SELL Redis message:",
            sellMessageId,
        );

        /*
         * Verify both messages belong to
         * the fake consumer.
         */

        await waitForPending(
            buyMessageId,
        );

        await waitForPending(
            sellMessageId,
        );

        console.log(
            "\n✅ Both messages are PENDING",
        );

        /*
         * --------------------------------------------------
         * 6. SIMULATE CONSUMER CRASH
         * --------------------------------------------------
         *
         * The fake consumer simply disappears.
         *
         * The messages remain pending because
         * they were never acknowledged.
         */

        console.log(
            "\nSimulating crashed consumer:",
            CRASH_CONSUMER,
        );

        /*
         * Wait until the consumer's configured
         * 5-second idle threshold is exceeded.
         */

        console.log(
            `Waiting ${RECOVERY_IDLE_TIME + 1000}ms for recovery eligibility...`,
        );

        await wait(
            RECOVERY_IDLE_TIME + 1000,
        );

        /*
         * --------------------------------------------------
         * 7. START REAL CONSUMER
         * --------------------------------------------------
         */

        consumer =
            startRealConsumer();

        /*
         * Give the consumer time to:
         *
         * XPENDING
         * XCLAIM
         * processOrderMessage
         */

        console.log(
            "\nWaiting for pending-message recovery...",
        );

        await wait(7000);

        /*
         * --------------------------------------------------
         * 8. VERIFY ORDERS WERE RECOVERED
         * --------------------------------------------------
         */

        const buyOrder =
            await waitForOrder(
                buyOrderId,
                "FILLED",
            );

        const sellOrder =
            await waitForOrder(
                sellOrderId,
                "FILLED",
            );

        console.log(
            "\n✅ BUY recovered and FILLED",
        );

        console.log(
            "BUY:",
            buyOrder.id,
        );

        console.log(
            "\n✅ SELL recovered and FILLED",
        );

        console.log(
            "SELL:",
            sellOrder.id,
        );

        /*
         * --------------------------------------------------
         * 9. VERIFY EXACTLY ONE TRADE
         * --------------------------------------------------
         */

        const trades =
            await prisma.trade.count({
                where: {
                    OR: [
                        {
                            buyOrderId,
                        },
                        {
                            sellOrderId,
                        },
                    ],
                },
            });

        console.log(
            "\nTrades created:",
            trades,
        );

        assert(
            trades === 1,
            `Expected exactly 1 trade, got ${trades}`,
        );

        /*
         * --------------------------------------------------
         * 10. VERIFY BALANCES
         * --------------------------------------------------
         */

        const buyerUSDT =
            await getBalance(
                buyer.id,
                "USDT",
            );

        const buyerETH =
            await getBalance(
                buyer.id,
                "ETH",
            );

        const sellerUSDT =
            await getBalance(
                seller.id,
                "USDT",
            );

        const sellerETH =
            await getBalance(
                seller.id,
                "ETH",
            );

        assert(
            !!buyerUSDT,
            "Buyer USDT balance missing",
        );

        assert(
            !!buyerETH,
            "Buyer ETH balance missing",
        );

        assert(
            !!sellerUSDT,
            "Seller USDT balance missing",
        );

        assert(
            !!sellerETH,
            "Seller ETH balance missing",
        );

        /*
         * BUY:
         *
         * 5000 USDT
         * -2000 USDT
         * =3000 USDT
         *
         * +1 ETH
         */
        if(buyerUSDT===null || buyerETH===null || sellerUSDT===null || sellerETH===null){
            throw new Error("Line 764 is null")
        }
        assert(
            buyerUSDT.available.equals(3000),
            `Expected buyer USDT available = 3000, got ${buyerUSDT.available}`,
        );

        assert(
            buyerUSDT.locked.equals(0),
            `Expected buyer USDT locked = 0, got ${buyerUSDT.locked}`,
        );

        assert(
            buyerETH.available.equals(1),
            `Expected buyer ETH available = 1, got ${buyerETH.available}`,
        );

        /*
         * SELL:
         *
         * 2 ETH
         * -1 ETH
         * =1 ETH
         *
         * +2000 USDT
         */

        assert(
            sellerETH.available.equals(1),
            `Expected seller ETH available = 1, got ${sellerETH.available}`,
        );

        assert(
            sellerETH.locked.equals(0),
            `Expected seller ETH locked = 0, got ${sellerETH.locked}`,
        );

        assert(
            sellerUSDT.available.equals(2000),
            `Expected seller USDT available = 2000, got ${sellerUSDT.available}`,
        );

        assert(
            sellerUSDT.locked.equals(0),
            `Expected seller USDT locked = 0, got ${sellerUSDT.locked}`,
        );

        /*
         * --------------------------------------------------
         * 11. VERIFY NO PENDING MESSAGE REMAINS
         * --------------------------------------------------
         */

        const pending =
            (await redis.xpending(
                ORDER_STREAM,
                CONSUMER_GROUP,
                "-",
                "+",
                100,
            )) as Array<
                [
                    string,
                    string,
                    number,
                    string,
                ]
            >;

        const buyStillPending =
            pending.some(
                (entry) =>
                    entry[0] ===
                    buyMessageId,
            );

        const sellStillPending =
            pending.some(
                (entry) =>
                    entry[0] ===
                    sellMessageId,
            );

        assert(
            !buyStillPending,
            "BUY Redis message is still pending",
        );

        assert(
            !sellStillPending,
            "SELL Redis message is still pending",
        );

        /*
         * --------------------------------------------------
         * FINAL RESULT
         * --------------------------------------------------
         */

        console.log(
            "\n========================================",
        );

        console.log(
            "     ✅ REDIS RECOVERY PASSED",
        );

        console.log(
            "========================================",
        );

        console.log(`
Verified:

✅ Messages became PENDING
✅ Messages belonged to crashed consumer
✅ Messages exceeded recovery idle time
✅ Real consumer recovered messages
✅ XCLAIM recovery path executed
✅ BUY order recovered successfully
✅ SELL order recovered successfully
✅ Orders matched correctly
✅ Exactly one trade created
✅ Buyer settlement correct
✅ Seller settlement correct
✅ No balance duplication
✅ Recovered messages acknowledged
`);
    } finally {
        /*
         * Always stop the consumer that this test
         * started.
         */

        stopConsumer(consumer);

        await prisma.$disconnect();

        redis.disconnect();
    }
}

main().catch((error: unknown) => {
    console.error(
        "\n========================================",
    );

    console.error(
        "     ❌ REDIS RECOVERY FAILED",
    );

    console.error(
        "========================================",
    );

    console.error(error);

    process.exit(1);
});