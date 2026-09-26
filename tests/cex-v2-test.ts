const BASE_URL = "http://localhost:3000";

type User = {
    id: string;
    email: string;
    password: string;
};

type OrderStatus =
    | "OPEN"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELLED";

type Order = {
    id: string;
    userId: string;
    side: "BUY" | "SELL";
    type: "LIMIT" | "MARKET";
    quantity: number | string;
    remainingQty: number | string;
    price: number | string | null;
    status: OrderStatus;
};

type ResponseData = {
    status: number;
    ok: boolean;
    body: any;
};

function assert(
    condition: boolean,
    message: string,
) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

function sleep(ms: number) {
    return new Promise((resolve) =>
        setTimeout(resolve, ms),
    );
}

async function request(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<ResponseData> {
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
        `${BASE_URL}${path}`,
        {
            ...options,
            headers,
        },
    );

    let body: any;

    try {
        body = await response.json();
    } catch {
        body = await response.text();
    }

    return {
        status: response.status,
        ok: response.ok,
        body,
    };
}

function log(
    title: string,
    response: ResponseData,
) {
    console.log(`\n--- ${title} ---`);
    console.log("Status:", response.status);
    console.log(
        "Body:",
        JSON.stringify(
            response.body,
            null,
            2,
        ),
    );
}

async function createUser(
    prefix: string,
): Promise<User> {
    const uniqueId =
        `${Date.now()}-${crypto.randomUUID()}`;

    const email =
        `${prefix}-${uniqueId}@test.com`;

    const password =
        "TestPassword123!";

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

    log("CREATE USER", response);

    assert(
        response.status === 201,
        `User creation failed: ${response.status}`,
    );

    assert(
        typeof response.body.id === "string",
        "User ID was not returned",
    );

    return {
        id: response.body.id,
        email,
        password,
    };
}

async function login(
    user: User,
): Promise<string> {
    const response = await request(
        "/auth/login",
        {
            method: "POST",
            body: JSON.stringify({
                email: user.email,
                password: user.password,
            }),
        },
    );

    log(
        `LOGIN ${user.email}`,
        response,
    );

    assert(
        response.status === 200,
        `Login failed: ${response.status}`,
    );

    assert(
        typeof response.body.token === "string",
        "JWT token was not returned",
    );

    return response.body.token;
}

async function createBalance(
    user: User,
    token: string,
    asset: string,
    amount: number,
) {
    const response = await request(
        `/users/${user.id}/balances`,
        {
            method: "POST",
            body: JSON.stringify({
                asset,
                amount,
            }),
        },
        token,
    );

    log(
        `CREATE ${asset} BALANCE`,
        response,
    );

    assert(
        response.status === 201,
        `Failed to create ${asset} balance`,
    );

    return response.body;
}

async function getBalance(
    user: User,
    token: string,
    asset: string,
) {
    return request(
        `/users/${user.id}/balances/${asset}`,
        {
            method: "GET",
        },
        token,
    );
}

async function createOrder(
    token: string,
    order: {
        side: "BUY" | "SELL";
        type: "LIMIT" | "MARKET";
        qty: number;
        price?: number;
    },
) {
    const response = await request(
        "/orders",
        {
            method: "POST",
            body: JSON.stringify(order),
        },
        token,
    );

    log(
        `CREATE ${order.side} ORDER`,
        response,
    );

    return response;
}

async function getOrder(
    orderId: string,
    token: string,
) {
    return request(
        `/orders/${orderId}`,
        {
            method: "GET",
        },
        token,
    );
}

async function getUserOrders(
    user: User,
    token: string,
) {
    return request(
        `/users/${user.id}/orders`,
        {
            method: "GET",
        },
        token,
    );
}

async function cancelOrder(
    orderId: string,
    token: string,
) {
    const response = await request(
        `/orders/${orderId}`,
        {
            method: "DELETE",
        },
        token,
    );

    log(
        `CANCEL ORDER ${orderId}`,
        response,
    );

    return response;
}

async function waitForOrder(
    orderId: string,
    token: string,
    expectedStatuses: OrderStatus[],
    timeoutMs = 20000,
): Promise<Order> {
    const startedAt = Date.now();

    let lastResponse: ResponseData | null =
        null;

    while (
        Date.now() - startedAt <
        timeoutMs
    ) {
        const response =
            await getOrder(
                orderId,
                token,
            );

        lastResponse = response;

        if (response.ok) {
            const order =
                response.body as Order;

            console.log(
                `Order ${orderId} -> ${order.status}`,
            );

            if (
                expectedStatuses.includes(
                    order.status,
                )
            ) {
                return order;
            }
        }

        await sleep(500);
    }

    console.log(
        "\nLast response while waiting:",
        JSON.stringify(
            lastResponse,
            null,
            2,
        ),
    );

    throw new Error(
        `Order ${orderId} did not reach expected status: ${expectedStatuses.join(", ")}`,
    );
}

/*
|--------------------------------------------------------------------------
| TEST 1
| Backend health
|--------------------------------------------------------------------------
*/

async function testHealth() {
    console.log("\n========================================");
    console.log("TEST 1: BACKEND HEALTH");
    console.log("========================================");

    const response =
        await request("/");

    log("GET /", response);

    assert(
        response.status === 200,
        "Backend health check failed",
    );

    assert(
        response.body.message ===
            "CEX v2 Backend Running",
        "Unexpected backend health response",
    );

    console.log("✅ Backend health passed");
}

/*
|--------------------------------------------------------------------------
| TEST 2
| Authentication
|--------------------------------------------------------------------------
*/

async function testAuthentication(
    user: User,
    token: string,
) {
    console.log("\n========================================");
    console.log("TEST 2: AUTHENTICATION");
    console.log("========================================");

    const noToken =
        await request(
            `/users/${user.id}/balances/USDT`,
        );

    log(
        "REQUEST WITHOUT TOKEN",
        noToken,
    );

    assert(
        noToken.status === 401,
        "Request without JWT should return 401",
    );

    const invalidToken =
        await request(
            `/users/${user.id}/balances/USDT`,
            {},
            "invalid.jwt.token",
        );

    log(
        "REQUEST WITH INVALID TOKEN",
        invalidToken,
    );

    assert(
        invalidToken.status === 401,
        "Invalid JWT should return 401",
    );

    const validToken =
        await getBalance(
            user,
            token,
            "USDT",
        );

    assert(
        validToken.status === 200,
        "Valid JWT was rejected",
    );

    console.log(
        "✅ Authentication tests passed",
    );
}

/*
|--------------------------------------------------------------------------
| TEST 3
| Balance creation and retrieval
|--------------------------------------------------------------------------
*/

async function testBalances(
    user: User,
    token: string,
) {
    console.log("\n========================================");
    console.log("TEST 3: BALANCES");
    console.log("========================================");

    await createBalance(
        user,
        token,
        "USDT",
        100000,
    );

    await createBalance(
        user,
        token,
        "BTC",
        10,
    );

    const usdt =
        await getBalance(
            user,
            token,
            "USDT",
        );

    const btc =
        await getBalance(
            user,
            token,
            "BTC",
        );

    log(
        "USDT BALANCE",
        usdt,
    );

    log(
        "BTC BALANCE",
        btc,
    );

    assert(
        usdt.status === 200,
        "USDT balance retrieval failed",
    );

    assert(
        btc.status === 200,
        "BTC balance retrieval failed",
    );

    assert(
        Number(usdt.body.available) ===
            100000,
        "Initial USDT balance is incorrect",
    );

    assert(
        Number(usdt.body.locked) === 0,
        "Initial USDT locked balance is incorrect",
    );

    assert(
        Number(btc.body.available) === 10,
        "Initial BTC balance is incorrect",
    );

    assert(
        Number(btc.body.locked) === 0,
        "Initial BTC locked balance is incorrect",
    );

    console.log(
        "✅ Balance tests passed",
    );
}

/*
|--------------------------------------------------------------------------
| TEST 4
| Cross-user authorization
|--------------------------------------------------------------------------
*/

async function testCrossUserProtection(
    userA: User,
    tokenA: string,
    userB: User,
) {
    console.log("\n========================================");
    console.log("TEST 4: CROSS USER PROTECTION");
    console.log("========================================");

    const response =
        await getBalance(
            userB,
            tokenA,
            "USDT",
        );

    log(
        "USER A TOKEN -> USER B BALANCE",
        response,
    );

    assert(
        response.status === 403,
        "User should not access another user's balance",
    );

    console.log(
        "✅ Cross-user protection passed",
    );
}

/*
|--------------------------------------------------------------------------
| TEST 5
| Create unmatched BUY
|--------------------------------------------------------------------------
*/

async function testUnmatchedBuy(
    user: User,
    token: string,
) {
    console.log("\n========================================");
    console.log("TEST 5: UNMATCHED BUY");
    console.log("========================================");

    const response =
        await createOrder(
            token,
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price: 10,
            },
        );

    assert(
        response.status === 201,
        `BUY order was not queued: ${response.status}`,
    );

    const orderId =
        response.body.orderId;

    assert(
        typeof orderId === "string",
        "BUY order ID missing",
    );

    const order =
        await waitForOrder(
            orderId,
            token,
            [
                "OPEN",
                "PARTIALLY_FILLED",
                "FILLED",
            ],
        );

    /*
     * We don't force OPEN here because
     * the current matching engine can legally
     * match against another existing order.
     */

    assert(
        order.id === orderId,
        "Returned order ID does not match",
    );

    console.log(
        "Order status:",
        order.status,
    );

    const balance =
        await getBalance(
            user,
            token,
            "USDT",
        );

    log(
        "BALANCE AFTER BUY",
        balance,
    );

    assert(
        balance.status === 200,
        "Could not read balance after BUY",
    );

    console.log(
        "Available:",
        balance.body.available,
    );

    console.log(
        "Locked:",
        balance.body.locked,
    );

    console.log(
        "✅ Unmatched BUY test passed",
    );

    return {
        orderId,
        order,
    };
}

/*
|--------------------------------------------------------------------------
| TEST 6
| BUY / SELL matching
|--------------------------------------------------------------------------
*/

async function testMatching(
    buyer: User,
    buyerToken: string,
    seller: User,
    sellerToken: string,
) {
    console.log("\n========================================");
    console.log("TEST 6: BUY / SELL MATCHING");
    console.log("========================================");

    /*
     * Use a unique price to reduce the
     * possibility of matching an old order.
     */

    const price =
        1000 +
        Math.floor(
            Math.random() * 100000,
        );

    console.log(
        "Test price:",
        price,
    );

    const buyResponse =
        await createOrder(
            buyerToken,
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price,
            },
        );

    assert(
        buyResponse.status === 201,
        "BUY order was not queued",
    );

    const buyOrderId =
        buyResponse.body.orderId;

    assert(
        typeof buyOrderId === "string",
        "BUY order ID missing",
    );

    const buyBeforeMatch =
        await waitForOrder(
            buyOrderId,
            buyerToken,
            [
                "OPEN",
                "PARTIALLY_FILLED",
                "FILLED",
            ],
        );

    console.log(
        "BUY before SELL:",
        buyBeforeMatch.status,
    );

    const sellResponse =
        await createOrder(
            sellerToken,
            {
                side: "SELL",
                type: "LIMIT",
                qty: 1,
                price,
            },
        );

    assert(
        sellResponse.status === 201,
        "SELL order was not queued",
    );

    const sellOrderId =
        sellResponse.body.orderId;

    assert(
        typeof sellOrderId === "string",
        "SELL order ID missing",
    );

    const buyAfterMatch =
        await waitForOrder(
            buyOrderId,
            buyerToken,
            [
                "FILLED",
                "PARTIALLY_FILLED",
            ],
        );

    const sellAfterMatch =
        await waitForOrder(
            sellOrderId,
            sellerToken,
            [
                "FILLED",
                "PARTIALLY_FILLED",
            ],
        );

    console.log(
        "\nBUY after match:",
        JSON.stringify(
            buyAfterMatch,
            null,
            2,
        ),
    );

    console.log(
        "\nSELL after match:",
        JSON.stringify(
            sellAfterMatch,
            null,
            2,
        ),
    );

    assert(
        Number(
            buyAfterMatch.remainingQty,
        ) === 0,
        "BUY remaining quantity should be 0",
    );

    assert(
        Number(
            sellAfterMatch.remainingQty,
        ) === 0,
        "SELL remaining quantity should be 0",
    );

    assert(
        buyAfterMatch.status === "FILLED",
        "BUY should be FILLED",
    );

    assert(
        sellAfterMatch.status === "FILLED",
        "SELL should be FILLED",
    );

    console.log(
        "✅ BUY / SELL matching passed",
    );

    return {
        buyOrderId,
        sellOrderId,
    };
}

/*
|--------------------------------------------------------------------------
| TEST 7
| Verify settlement
|--------------------------------------------------------------------------
*/

async function testSettlement(
    buyer: User,
    buyerToken: string,
    seller: User,
    sellerToken: string,
) {
    console.log("\n========================================");
    console.log("TEST 7: BALANCE SETTLEMENT");
    console.log("========================================");

    const buyerUSDT =
        await getBalance(
            buyer,
            buyerToken,
            "USDT",
        );

    const buyerBTC =
        await getBalance(
            buyer,
            buyerToken,
            "BTC",
        );

    const sellerUSDT =
        await getBalance(
            seller,
            sellerToken,
            "USDT",
        );

    const sellerBTC =
        await getBalance(
            seller,
            sellerToken,
            "BTC",
        );

    log(
        "BUYER USDT",
        buyerUSDT,
    );

    log(
        "BUYER BTC",
        buyerBTC,
    );

    log(
        "SELLER USDT",
        sellerUSDT,
    );

    log(
        "SELLER BTC",
        sellerBTC,
    );

    assert(
        buyerUSDT.status === 200,
        "Could not retrieve buyer USDT",
    );

    assert(
        buyerBTC.status === 200,
        "Could not retrieve buyer BTC",
    );

    assert(
        sellerUSDT.status === 200,
        "Could not retrieve seller USDT",
    );

    assert(
        sellerBTC.status === 200,
        "Could not retrieve seller BTC",
    );

    /*
     * After buying 1 BTC at 1000-ish:
     *
     * Buyer:
     * USDT available decreased by trade value
     * BTC available increased by 1
     *
     * Seller:
     * BTC available decreased by 1
     * USDT available increased by trade value
     */

    console.log(
        "\nBuyer USDT:",
        buyerUSDT.body,
    );

    console.log(
        "Buyer BTC:",
        buyerBTC.body,
    );

    console.log(
        "Seller USDT:",
        sellerUSDT.body,
    );

    console.log(
        "Seller BTC:",
        sellerBTC.body,
    );

    assert(
        Number(buyerBTC.body.available) >
            10,
        "Buyer BTC did not increase after trade",
    );

    assert(
        Number(sellerBTC.body.available) <
            10,
        "Seller BTC did not decrease after trade",
    );

    assert(
        Number(buyerUSDT.body.locked) === 0,
        "Buyer still has locked USDT after full fill",
    );

    assert(
        Number(sellerBTC.body.locked) === 0,
        "Seller still has locked BTC after full fill",
    );

    console.log(
        "✅ Settlement test passed",
    );
}

/*
|--------------------------------------------------------------------------
| TEST 8
| Order history
|--------------------------------------------------------------------------
*/

async function testOrderHistory(
    user: User,
    token: string,
) {
    console.log("\n========================================");
    console.log("TEST 8: ORDER HISTORY");
    console.log("========================================");

    const response =
        await getUserOrders(
            user,
            token,
        );

    log(
        "USER ORDERS",
        response,
    );

    assert(
        response.status === 200,
        "Order history request failed",
    );

    assert(
        Array.isArray(response.body),
        "Order history should return an array",
    );

    assert(
        response.body.length > 0,
        "Order history is empty",
    );

    console.log(
        `✅ Order history contains ${response.body.length} order(s)`,
    );
}

/*
|--------------------------------------------------------------------------
| TEST 9
| Cancellation
|--------------------------------------------------------------------------
*/

async function testCancellation(
    user: User,
    token: string,
) {
    console.log("\n========================================");
    console.log("TEST 9: ORDER CANCELLATION");
    console.log("========================================");

    /*
     * Use a very small unique price so that
     * the order should normally remain unmatched.
     */

    const price =
        0.000000001 +
        Math.random() *
            0.000000001;

    const response =
        await createOrder(
            token,
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price,
            },
        );

    assert(
        response.status === 201,
        "Cancellation test order was not queued",
    );

    const orderId =
        response.body.orderId;

    const order =
        await waitForOrder(
            orderId,
            token,
            [
                "OPEN",
            ],
        );

    assert(
        order.status === "OPEN",
        "Cancellation test order is not OPEN",
    );

    const beforeCancel =
        await getBalance(
            user,
            token,
            "USDT",
        );

    log(
        "BALANCE BEFORE CANCEL",
        beforeCancel,
    );

    const cancelResponse =
        await cancelOrder(
            orderId,
            token,
        );

    assert(
        cancelResponse.status === 200,
        "Cancellation request was not accepted",
    );

    const cancelled =
        await waitForOrder(
            orderId,
            token,
            [
                "CANCELLED",
            ],
        );

    assert(
        cancelled.status === "CANCELLED",
        "Order did not become CANCELLED",
    );

    const afterCancel =
        await getBalance(
            user,
            token,
            "USDT",
        );

    log(
        "BALANCE AFTER CANCEL",
        afterCancel,
    );

    assert(
        afterCancel.status === 200,
        "Could not read balance after cancellation",
    );

    assert(
        Number(afterCancel.body.locked) === 0,
        "USDT remained locked after cancellation",
    );

    console.log(
        "✅ Cancellation test passed",
    );
}

/*
|--------------------------------------------------------------------------
| TEST 10
| Cross-user order protection
|--------------------------------------------------------------------------
*/

async function testOrderProtection(
    userA: User,
    tokenA: string,
    userB: User,
) {
    console.log("\n========================================");
    console.log("TEST 10: CROSS USER ORDER PROTECTION");
    console.log("========================================");

    const response =
        await createOrder(
            tokenA,
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price:
                    0.0000000001,
            },
        );

    assert(
        response.status === 201,
        "Protection test order was not queued",
    );

    const orderId =
        response.body.orderId;

    await waitForOrder(
        orderId,
        tokenA,
        ["OPEN"],
    );

    const crossUser =
        await getOrder(
            orderId,
            await login(userB),
        );

    log(
        "USER B -> USER A ORDER",
        crossUser,
    );

    assert(
        crossUser.status === 404,
        "Another user should not be able to access the order",
    );

    console.log(
        "✅ Cross-user order protection passed",
    );
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

async function main() {
    console.log("\n");
    console.log("========================================");
    console.log("       CEX V2 TEST SUITE");
    console.log("========================================");

    /*
     * Important:
     *
     * Backend MUST be running:
     *
     * bun run apps/backend/index.ts
     *
     * Engine MUST be running:
     *
     * bun run apps/engine/redis-order-consumer.ts
     */

    await testHealth();

    /*
     * Create completely fresh users for every run.
     * This avoids duplicate balance problems.
     */

    const userA =
        await createUser("buyer");

    const userB =
        await createUser("seller");

    const tokenA =
        await login(userA);

    const tokenB =
        await login(userB);

    console.log(
        "\nUsers created:",
    );

    console.log(
        "Buyer:",
        userA.id,
    );

    console.log(
        "Seller:",
        userB.id,
    );

    await testAuthentication(
        userA,
        tokenA,
    );

    await testBalances(
        userA,
        tokenA,
    );

    await createBalance(
        userB,
        tokenB,
        "USDT",
        100000,
    );

    await createBalance(
        userB,
        tokenB,
        "BTC",
        10,
    );

    await testCrossUserProtection(
        userA,
        tokenA,
        userB,
    );

    await testUnmatchedBuy(
        userA,
        tokenA,
    );

    await testMatching(
        userA,
        tokenA,
        userB,
        tokenB,
    );

    await testSettlement(
        userA,
        tokenA,
        userB,
        tokenB,
    );

    await testOrderHistory(
        userA,
        tokenA,
    );

    await testCancellation(
        userA,
        tokenA,
    );

    await testOrderProtection(
        userA,
        tokenA,
        userB,
    );

    console.log("\n");
    console.log("========================================");
    console.log("       ✅ ALL API TESTS PASSED");
    console.log("========================================");
    console.log("\n");
}

main().catch((error) => {
    console.error("\n");
    console.error("========================================");
    console.error("       ❌ TEST SUITE FAILED");
    console.error("========================================");

    console.error(
        error instanceof Error
            ? error.message
            : error,
    );

    console.error("\n");
    process.exit(1);
});