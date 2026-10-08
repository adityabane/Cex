import { randomUUID } from "crypto";
import { prisma } from "../apps/engine/db";
import { redis } from "../apps/engine/redis";

const API_URL = "http://localhost:3000";

type RequestResult = {
    status: number;
    body: any;
};

async function request(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<RequestResult> {
    const headers = new Headers(options.headers);

    headers.set("Content-Type", "application/json");

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

function assert(
    condition: boolean,
    message: string,
) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function wait(ms: number) {
    await new Promise((resolve) =>
        setTimeout(resolve, ms),
    );
}

async function createUser(
    email: string,
    password: string,
) {
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
        `User creation failed: ${JSON.stringify(response.body)}`,
    );

    assert(
        !!response.body.id,
        "User creation did not return user ID",
    );

    return {
        id: response.body.id as string,
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
        `Login failed: ${JSON.stringify(response.body)}`,
    );

    assert(
        !!response.body.token,
        "Login did not return JWT token",
    );

    return response.body.token;
}

async function createBalance(
    userId: string,
    token: string,
    asset: string,
    amount: number,
) {
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

    return response.body;
}

async function createOrder(
    token: string,
    asset: string,
    side: "BUY" | "SELL",
    qty: number,
    price: number,
): Promise<string> {
    const response = await request(
        "/orders",
        {
            method: "POST",
            body: JSON.stringify({
                asset,
                side,
                type: "LIMIT",
                qty,
                price,
            }),
        },
        token,
    );

    assert(
        response.status === 201,
        `Order creation failed: ${JSON.stringify(
            response.body,
        )}`,
    );

    assert(
        !!response.body.orderId,
        "Order creation did not return orderId",
    );

    return response.body.orderId;
}

async function waitForOrderStatus(
    orderId: string,
    expectedStatus: string,
    timeoutMs = 10000,
) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const order = await prisma.order.findUnique({
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

    const finalOrder =
        await prisma.order.findUnique({
            where: {
                id: orderId,
            },
        });

    throw new Error(
        `Timed out waiting for order ${orderId} to become ${expectedStatus}. ` +
        `Current status: ${finalOrder?.status}`,
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

async function main() {
    console.log("========================================");
    console.log("     REDIS IDEMPOTENCY TEST");
    console.log("========================================");

    /*
     * --------------------------------------------------
     * 1. CREATE UNIQUE USERS
     * --------------------------------------------------
     */

    console.log("\nCreating users...");

    const uniqueId = randomUUID();

    const buyerEmail =
        `redis-idempotency-buyer-${uniqueId}@test.com`;

    const sellerEmail =
        `redis-idempotency-seller-${uniqueId}@test.com`;

    const password = "TestPassword123!";

    const buyer = await createUser(
        buyerEmail,
        password,
    );

    const seller = await createUser(
        sellerEmail,
        password,
    );

    const buyerToken = await login(
        buyer.email,
        buyer.password,
    );

    const sellerToken = await login(
        seller.email,
        seller.password,
    );

    console.log("Buyer:", buyer.id);
    console.log("Seller:", seller.id);

    /*
     * --------------------------------------------------
     * 2. CREATE BALANCES
     * --------------------------------------------------
     */

    console.log("\nCreating balances...");

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

    console.log("Buyer USDT: 5000");
    console.log("Seller ETH: 2");

    /*
     * --------------------------------------------------
     * 3. CREATE MATCHING ORDERS
     * --------------------------------------------------
     *
     * BUY:
     *     1 ETH @ 2000 USDT
     *
     * SELL:
     *     1 ETH @ 2000 USDT
     *
     * Expected:
     *     Buyer receives 1 ETH
     *     Seller receives 2000 USDT
     */

    console.log("\nCreating BUY order...");

    const buyOrderId = await createOrder(
        buyerToken,
        "ETH",
        "BUY",
        1,
        2000,
    );

    console.log(
        "BUY order:",
        buyOrderId,
    );

    console.log("\nCreating SELL order...");

    const sellOrderId = await createOrder(
        sellerToken,
        "ETH",
        "SELL",
        1,
        2000,
    );

    console.log(
        "SELL order:",
        sellOrderId,
    );

    /*
     * --------------------------------------------------
     * 4. WAIT FOR MATCHING
     * --------------------------------------------------
     */

    await waitForOrderStatus(
        buyOrderId,
        "FILLED",
    );

    await waitForOrderStatus(
        sellOrderId,
        "FILLED",
    );

    console.log(
        "\n✅ Initial trade completed",
    );

    /*
     * --------------------------------------------------
     * 5. CAPTURE STATE BEFORE REDIS REPLAY
     * --------------------------------------------------
     */

    const buyerUSDTBefore =
        await getBalance(
            buyer.id,
            "USDT",
        );

    const buyerETHBefore =
        await getBalance(
            buyer.id,
            "ETH",
        );

    const sellerUSDTBefore =
        await getBalance(
            seller.id,
            "USDT",
        );

    const sellerETHBefore =
        await getBalance(
            seller.id,
            "ETH",
        );

    assert(
        !!buyerUSDTBefore,
        "Buyer USDT balance missing",
    );

    assert(
        !!buyerETHBefore,
        "Buyer ETH balance missing",
    );

    assert(
        !!sellerUSDTBefore,
        "Seller USDT balance missing",
    );

    assert(
        !!sellerETHBefore,
        "Seller ETH balance missing",
    );

    const tradesBefore =
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
        "\nState before duplicate Redis delivery:",
    );
    if(sellerETHBefore===null || buyerETHBefore===null || sellerUSDTBefore===null || buyerUSDTBefore===null){
        throw new Error("seller and buyer eth or usd is null")
    }
    console.log(
        "Buyer USDT:",
        buyerUSDTBefore.available.toString(),
        "available /",
        buyerUSDTBefore.locked.toString(),
        "locked",
    );

    console.log(
        "Buyer ETH:",
        buyerETHBefore.available.toString(),
        "available /",
        buyerETHBefore.locked.toString(),
        "locked",
    );

    console.log(
        "Seller USDT:",
        sellerUSDTBefore.available.toString(),
        "available /",
        sellerUSDTBefore.locked.toString(),
        "locked",
    );

    console.log(
        "Seller ETH:",
        sellerETHBefore.available.toString(),
        "available /",
        sellerETHBefore.locked.toString(),
        "locked",
    );

    console.log(
        "Trades:",
        tradesBefore,
    );

    assert(
        tradesBefore === 1,
        `Expected exactly 1 trade before replay, got ${tradesBefore}`,
    );

    /*
     * --------------------------------------------------
     * 6. REPLAY THE SAME ORDER THROUGH REDIS
     * --------------------------------------------------
     *
     * This simulates Redis delivering the same
     * order event again.
     *
     * IMPORTANT:
     * We use the EXACT SAME orderId.
     */

    console.log(
        "\nReplaying SAME BUY order through Redis...",
    );

    const duplicateMessageId =
        await redis.xadd(
            "cex:orders",
            "*",

            "orderId",
            buyOrderId,

            "userId",
            buyer.id,

            "asset",
            "ETH",

            "side",
            "BUY",

            "type",
            "LIMIT",

            "qty",
            "1",

            "price",
            "2000",
        );

    console.log(
        "Duplicate Redis message:",
        duplicateMessageId,
    );

    /*
     * Give the Redis consumer enough time
     * to process the duplicate.
     */

    await wait(3000);

    /*
     * --------------------------------------------------
     * 7. READ STATE AFTER DUPLICATE DELIVERY
     * --------------------------------------------------
     */

    const buyerUSDTAfter =
        await getBalance(
            buyer.id,
            "USDT",
        );

    const buyerETHAfter =
        await getBalance(
            buyer.id,
            "ETH",
        );

    const sellerUSDTAfter =
        await getBalance(
            seller.id,
            "USDT",
        );

    const sellerETHAfter =
        await getBalance(
            seller.id,
            "ETH",
        );

    assert(
        !!buyerUSDTAfter,
        "Buyer USDT balance disappeared after replay",
    );

    assert(
        !!buyerETHAfter,
        "Buyer ETH balance disappeared after replay",
    );

    assert(
        !!sellerUSDTAfter,
        "Seller USDT balance disappeared after replay",
    );

    assert(
        !!sellerETHAfter,
        "Seller ETH balance disappeared after replay",
    );

    const tradesAfter =
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

    const finalBuy =
        await prisma.order.findUnique({
            where: {
                id: buyOrderId,
            },
        });

    const finalSell =
        await prisma.order.findUnique({
            where: {
                id: sellOrderId,
            },
        });

    /*
     * --------------------------------------------------
     * 8. VERIFY IDEMPOTENCY
     * --------------------------------------------------
     */

    assert(
        tradesAfter === 1,
        `Duplicate Redis delivery created another trade. ` +
        `Expected 1, got ${tradesAfter}`,
    );

    assert(
        finalBuy?.status === "FILLED",
        `BUY order changed after replay: ${finalBuy?.status}`,
    );

    assert(
        finalSell?.status === "FILLED",
        `SELL order changed after replay: ${finalSell?.status}`,
    );
    if(sellerETHAfter===null || buyerETHAfter===null || sellerUSDTAfter===null || buyerUSDTAfter===null){
        throw new Error("seller and buyer eth or usd is null")
    }
    assert(
        buyerUSDTAfter.available.equals(
            buyerUSDTBefore.available,
        ),
        "Buyer USDT available balance changed after replay",
    );

    assert(
        buyerUSDTAfter.locked.equals(
            buyerUSDTBefore.locked,
        ),
        "Buyer USDT locked balance changed after replay",
    );

    assert(
        buyerETHAfter.available.equals(
            buyerETHBefore.available,
        ),
        "Buyer ETH available balance changed after replay",
    );

    assert(
        buyerETHAfter.locked.equals(
            buyerETHBefore.locked,
        ),
        "Buyer ETH locked balance changed after replay",
    );

    assert(
        sellerUSDTAfter.available.equals(
            sellerUSDTBefore.available,
        ),
        "Seller USDT available balance changed after replay",
    );

    assert(
        sellerUSDTAfter.locked.equals(
            sellerUSDTBefore.locked,
        ),
        "Seller USDT locked balance changed after replay",
    );

    assert(
        sellerETHAfter.available.equals(
            sellerETHBefore.available,
        ),
        "Seller ETH available balance changed after replay",
    );

    assert(
        sellerETHAfter.locked.equals(
            sellerETHBefore.locked,
        ),
        "Seller ETH locked balance changed after replay",
    );

    /*
     * --------------------------------------------------
     * 9. FINAL RESULT
     * --------------------------------------------------
     */

    console.log("\n========================================");
    console.log("     ✅ REDIS IDEMPOTENCY PASSED");
    console.log("========================================");

    console.log(`
Verified:

✅ Same order ID can be delivered again
✅ Existing order is not recreated
✅ Balance is not locked again
✅ No duplicate trade
✅ No duplicate settlement
✅ BUY remains FILLED
✅ SELL remains FILLED
✅ Buyer USDT unchanged
✅ Buyer ETH unchanged
✅ Seller USDT unchanged
✅ Seller ETH unchanged
`);
}

main()
    .catch((error) => {
        console.error(
            "\n========================================",
        );
        console.error(
            "     ❌ REDIS IDEMPOTENCY FAILED",
        );
        console.error(
            "========================================",
        );
        console.error(error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        redis.disconnect();
    });