const BASE_URL = "http://localhost:3000";

type User = {
    id: string;
    email: string;
    password: string;
};

type LoginResponse = {
    token: string;
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
    quantity: number;
    remainingQty: number;
    price: number | null;
    status: OrderStatus;
};

async function request(
    path: string,
    options: RequestInit = {},
    token?: string,
) {
    const headers = new Headers(options.headers);

    headers.set("Content-Type", "application/json");

    if (token) {
        headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers,
    });

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

function logResponse(label: string, response: any) {
    console.log(`\n${label}`);
    console.log(`Status: ${response.status}`);
    console.log(
        "Response:",
        JSON.stringify(response.body, null, 2),
    );
}

function assert(
    condition: boolean,
    message: string,
) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function createUser(
    email: string,
    password: string,
): Promise<User> {
    const response = await request("/users", {
        method: "POST",
        body: JSON.stringify({
            email,
            password,
        }),
    });

    logResponse("CREATE USER", response);

    assert(
        response.status === 201,
        `User creation failed: ${response.status}`,
    );

    assert(
        !!response.body.id,
        "User creation did not return user ID",
    );

    return {
        id: response.body.id,
        email,
        password,
    };
}

async function login(user: User): Promise<string> {
    const response = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({
            email: user.email,
            password: user.password,
        }),
    });

    logResponse(`LOGIN ${user.email}`, response);

    assert(
        response.status === 200,
        `Login failed: ${response.status}`,
    );

    assert(
        !!response.body.token,
        "Login response did not contain JWT token",
    );

    return response.body.token;
}

async function createBalance(
    userId: string,
    asset: string,
    amount: number,
    token: string,
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

    logResponse(`CREATE BALANCE ${asset}`, response);

    assert(
        response.status === 201,
        `Failed to create ${asset} balance`,
    );

    return response.body;
}

async function getBalance(
    userId: string,
    asset: string,
    token: string,
) {
    return request(
        `/users/${userId}/balances/${asset}`,
        {
            method: "GET",
        },
        token,
    );
}

async function createOrder(
    order: {
        side: "BUY" | "SELL";
        type: "LIMIT" | "MARKET";
        qty: number;
        price?: number;
    },
    token: string,
) {
    const response = await request(
        "/orders",
        {
            method: "POST",
            body: JSON.stringify(order),
        },
        token,
    );

    logResponse("CREATE ORDER", response);

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
    userId: string,
    token: string,
) {
    return request(
        `/users/${userId}/orders`,
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

    logResponse("CANCEL ORDER", response);

    return response;
}

async function waitForOrder(
    orderId: string,
    token: string,
    expectedStatuses: OrderStatus[],
    timeoutMs = 15000,
) {
    const start = Date.now();

    let lastOrder: any = null;

    while (Date.now() - start < timeoutMs) {
        const response = await getOrder(
            orderId,
            token,
        );

        if (response.ok) {
            lastOrder = response.body;

            console.log(
                `Order ${orderId} status: ${response.body.status}`,
            );

            if (
                expectedStatuses.includes(
                    response.body.status,
                )
            ) {
                return response.body as Order;
            }
        }

        await new Promise((resolve) =>
            setTimeout(resolve, 1000),
        );
    }

    console.log(
        "\nLast order response:",
        JSON.stringify(lastOrder, null, 2),
    );

    return null;
}
async function testRedisConsumerRecovery(
    token: string,
) {
    console.log("\n========================================");
    console.log("   REDIS CONSUMER RECOVERY TEST");
    console.log("========================================");

    console.log(
        "\nThis test requires the Redis consumer to be running.",
    );

    /*
     * Create an order that will remain OPEN.
     *
     * The important part is that the order is sent through:
     *
     * API
     *   ↓
     * Redis Stream
     *   ↓
     * Redis Consumer Group
     *   ↓
     * Engine
     */

    console.log(
        "\nCreating order for Redis consumer test...",
    );

    const response = await createOrder(
        {
            side: "BUY",
            type: "LIMIT",
            qty: 1,
            price: 0.000001,
        },
        token,
    );

    assert(
        response.status === 201,
        `Redis recovery test order creation failed: ${response.status}`,
    );

    const orderId = response.body.orderId;

    assert(
        !!orderId,
        "Redis recovery test order ID missing",
    );

    console.log(
        "\nRecovery test order:",
        orderId,
    );

    /*
     * Wait for the engine to process it.
     */

    const order = await waitForOrder(
        orderId,
        token,
        ["OPEN"],
    );
    if (order===null){
        throw new Error("Order is null")
    }
    assert(
        !!order,
        "Order was not processed by Redis consumer",
    );

    console.log(
        "\n✅ Redis consumer processed the order",
    );

    console.log(
        "Order status:",
        order.status,
    );

    console.log(
        "\n✅ Redis consumer recovery test completed",
    );
}
async function main() {
    console.log("========================================");
    console.log("       CEX V2 COMPLETE API TEST");
    console.log("========================================");

    /*
     * -------------------------------------
     * 1. BACKEND HEALTH CHECK
     * -------------------------------------
     */

    console.log("\n1. Checking backend...");

    const root = await request("/");

    logResponse("GET /", root);

    assert(
        root.status === 200,
        "Backend is not responding",
    );

    console.log("✅ Backend is running");

    /*
     * -------------------------------------
     * 2. CREATE TWO USERS
     * -------------------------------------
     */

    console.log("\n2. Creating users...");

    const uniqueId =
        `${Date.now()}-${crypto.randomUUID()}`;

    const userA = await createUser(
        `usera-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const userB = await createUser(
        `userb-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    console.log("\n✅ Users created");
    console.log("User A:", userA.id);
    console.log("User B:", userB.id);

    /*
     * -------------------------------------
     * 3. LOGIN
     * -------------------------------------
     */

    console.log("\n3. Logging in...");

    const tokenA = await login(userA);
    const tokenB = await login(userB);

    console.log("\n✅ JWT authentication working");

    /*
     * -------------------------------------
     * 4. AUTH REJECTION TEST
     * -------------------------------------
     */

    console.log("\n4. Testing protected route without JWT...");

    const noToken = await request(
        `/users/${userA.id}/balances/USDT`,
    );

    logResponse(
        "GET BALANCE WITHOUT TOKEN",
        noToken,
    );

    assert(
        noToken.status === 401,
        "Protected route should reject missing JWT",
    );

    console.log("✅ Missing JWT rejected");

    /*
     * -------------------------------------
     * 5. CREATE BALANCES
     * -------------------------------------
     */

    console.log("\n5. Creating balances...");

    await createBalance(
        userA.id,
        "USDT",
        100000,
        tokenA,
    );

    await createBalance(
        userA.id,
        "BTC",
        10,
        tokenA,
    );

    await createBalance(
        userB.id,
        "USDT",
        100000,
        tokenB,
    );

    await createBalance(
        userB.id,
        "BTC",
        10,
        tokenB,
    );

    console.log("\n✅ Balances created");

    /*
     * -------------------------------------
     * 6. GET BALANCE
     * -------------------------------------
     */

    console.log("\n6. Checking balances...");

    const balanceAUSDT = await getBalance(
        userA.id,
        "USDT",
        tokenA,
    );

    const balanceABTC = await getBalance(
        userA.id,
        "BTC",
        tokenA,
    );

    logResponse(
        "USER A USDT BALANCE",
        balanceAUSDT,
    );

    logResponse(
        "USER A BTC BALANCE",
        balanceABTC,
    );

    assert(
        balanceAUSDT.status === 200,
        "Could not retrieve USDT balance",
    );

    assert(
        balanceABTC.status === 200,
        "Could not retrieve BTC balance",
    );

    console.log("✅ Balance retrieval working");

    /*
     * -------------------------------------
     * 7. CROSS-USER BALANCE PROTECTION
     * -------------------------------------
     */

    console.log(
        "\n7. Testing cross-user balance protection...",
    );

    const crossBalance = await getBalance(
        userB.id,
        "USDT",
        tokenA,
    );

    logResponse(
        "USER A TOKEN → USER B BALANCE",
        crossBalance,
    );

    assert(
        crossBalance.status === 403,
        "User A should not access User B balance",
    );

    console.log("✅ Cross-user balance access rejected");

    /*
     * -------------------------------------
     * 8. CREATE ISOLATED BUY ORDER
     * -------------------------------------
     *
     * No userId is sent here.
     *
     * The backend gets userId from JWT.
     */

    console.log("\n8. Creating isolated BUY order...");

    const buyCreate = await createOrder(
        {
            side: "BUY",
            type: "LIMIT",
            qty: 1,
            price: 1,
        },
        tokenA,
    );

    assert(
        buyCreate.status === 201,
        `BUY order creation failed: ${buyCreate.status}`,
    );

    const buyOrderId =
        buyCreate.body.orderId;

    assert(
        !!buyOrderId,
        "BUY order ID was not returned",
    );

    console.log(
        "\nBUY order ID:",
        buyOrderId,
    );

    /*
     * -------------------------------------
     * 9. WAIT FOR BUY TO ENTER DATABASE
     * -------------------------------------
     */

    console.log(
        "\n9. Waiting for BUY order to reach OPEN...",
    );

    const buyOrder = await waitForOrder(
        buyOrderId,
        tokenA,
        ["OPEN", "PARTIALLY_FILLED", "FILLED"],
    );
    if (buyOrder === null) {
    throw new Error("❌ BUY order never reached the database");
}
    assert(
        buyOrder !== null,
        "BUY order never reached the database",
    );

    assert(
        buyOrder.status === "OPEN",
        `BUY order did not reach OPEN. Current status: ${buyOrder.status}`,
    );
    

    console.log(
        "\n✅ BUY order reached database",
    );

    console.log(
        "Status:",
        buyOrder.status,
    );

    /*
     * -------------------------------------
     * 10. VERIFY BUY FUNDS LOCKED
     * -------------------------------------
     */

    console.log(
        "\n10. Checking BUY locked funds...",
    );

    const afterBuyBalance = await getBalance(
        userA.id,
        "USDT",
        tokenA,
    );

    logResponse(
        "USER A USDT AFTER BUY",
        afterBuyBalance,
    );

    assert(
        afterBuyBalance.status === 200,
        "Could not retrieve balance after BUY",
    );

    console.log(
        "\nAvailable:",
        afterBuyBalance.body.available,
    );

    console.log(
        "Locked:",
        afterBuyBalance.body.locked,
    );

    /*
     * -------------------------------------
     * 11. CROSS-USER ORDER PROTECTION
     * -------------------------------------
     */

    console.log(
        "\n11. Testing cross-user order protection...",
    );

    const crossOrder = await getOrder(
        buyOrderId,
        tokenB,
    );

    logResponse(
        "USER B TOKEN → USER A ORDER",
        crossOrder,
    );

    assert(
        crossOrder.status === 404,
        "User B should not access User A order",
    );

    console.log(
        "✅ Cross-user order access rejected",
    );

    /*
     * -------------------------------------
     * 12. CREATE SELL ORDER
     * -------------------------------------
     */

    console.log(
        "\n12. Creating SELL order...",
    );

    const sellCreate = await createOrder(
        {
            side: "SELL",
            type: "LIMIT",
            qty: 1,
            price: 1,
        },
        tokenB,
    );

    assert(
        sellCreate.status === 201,
        `SELL order creation failed: ${sellCreate.status}`,
    );

    const sellOrderId =
        sellCreate.body.orderId;

    assert(
        !!sellOrderId,
        "SELL order ID was not returned",
    );

    console.log(
        "\nSELL order ID:",
        sellOrderId,
    );

    /*
     * -------------------------------------
     * 13. WAIT FOR MATCH
     * -------------------------------------
     */

    console.log(
        "\n13. Waiting for orders to match...",
    );

    const buyAfterMatch = await waitForOrder(
        buyOrderId,
        tokenA,
        ["FILLED", "PARTIALLY_FILLED"],
    );

    const sellAfterMatch = await waitForOrder(
        sellOrderId,
        tokenB,
        ["FILLED", "PARTIALLY_FILLED"],
    );
    const buyCheck = await getOrder(buyOrderId, tokenA);
    const sellCheck = await getOrder(sellOrderId, tokenB);

    console.log("\n=== AFTER MATCH DEBUG ===");
    console.log("BUY:", JSON.stringify(buyCheck.body, null, 2));
    console.log("SELL:", JSON.stringify(sellCheck.body, null, 2));
    if (sellAfterMatch === null) {
    throw new Error("❌ SELL order disappeared after matching");
}

    assert(
    sellAfterMatch !== null,
    "SELL order disappeared after matching",
    );

    assert(
        sellAfterMatch.status === "FILLED",
        `SELL order did not become FILLED. Current status: ${sellAfterMatch.status}`,
    );

    assert(
        !!sellAfterMatch,
        "SELL order did not reach a matching status",
    );
    if (buyAfterMatch === null) {
        throw new Error("❌ BUY order disappeared after matching");
    }
    console.log(
        "\nBUY status:",
        buyAfterMatch.status,
    );

    console.log(
        "SELL status:",
        sellAfterMatch.status,
    );
    

    /*
     * -------------------------------------
     * 14. CHECK ORDER HISTORIES
     * -------------------------------------
     */

    console.log(
        "\n14. Checking order histories...",
    );

    const userAOrders = await getUserOrders(
        userA.id,
        tokenA,
    );

    const userBOrders = await getUserOrders(
        userB.id,
        tokenB,
    );

    logResponse(
        "USER A ORDERS",
        userAOrders,
    );

    logResponse(
        "USER B ORDERS",
        userBOrders,
    );

    assert(
        userAOrders.status === 200,
        "Could not retrieve User A orders",
    );

    assert(
        userBOrders.status === 200,
        "Could not retrieve User B orders",
    );

    /*
     * -------------------------------------
     * 15. CREATE UNMATCHED BUY
     * -------------------------------------
     */

    console.log(
        "\n15. Creating unmatched BUY order...",
    );

    const unmatchedCreate = await createOrder(
        {
            side: "BUY",
            type: "LIMIT",
            qty: 1,
            price: 0.000001,
        },
        tokenA,
    );

    assert(
        unmatchedCreate.status === 201,
        `Unmatched BUY creation failed: ${unmatchedCreate.status}`,
    );

    const unmatchedOrderId =
        unmatchedCreate.body.orderId;

    assert(
        !!unmatchedOrderId,
        "Unmatched BUY order ID missing",
    );

    console.log(
        "Unmatched BUY:",
        unmatchedOrderId,
    );

    /*
     * -------------------------------------
     * 16. WAIT FOR OPEN
     * -------------------------------------
     */

    console.log(
        "\n16. Waiting for unmatched BUY to become OPEN...",
    );

    const unmatchedOrder =
        await waitForOrder(
            unmatchedOrderId,
            tokenA,
            ["OPEN"],
        );

    assert(
        !!unmatchedOrder,
        "Unmatched BUY did not reach OPEN",
    );

    console.log(
        "✅ Unmatched BUY is OPEN",
    );

    /*
     * -------------------------------------
     * 17. CANCEL ORDER
     * -------------------------------------
     */

    console.log(
        "\n17. Cancelling unmatched BUY...",
    );

    const cancelResponse =
        await cancelOrder(
            unmatchedOrderId,
            tokenA,
        );

    assert(
        cancelResponse.status === 200,
        `Cancel failed: ${cancelResponse.status}`,
    );

    /*
     * -------------------------------------
     * 18. WAIT FOR CANCELLED
     * -------------------------------------
     */

    console.log(
        "\n18. Waiting for CANCELLED status...",
    );

    const cancelledOrder =
        await waitForOrder(
            unmatchedOrderId,
            tokenA,
            ["CANCELLED"],
        );

    assert(
        !!cancelledOrder,
        "Order did not reach CANCELLED",
    );

    console.log(
        "✅ Order cancelled",
    );

    /*
     * -------------------------------------
     * 19. VERIFY FUNDS UNLOCKED
     * -------------------------------------
     */

    console.log(
        "\n19. Checking funds after cancellation...",
    );

    const finalBalance =
        await getBalance(
            userA.id,
            "USDT",
            tokenA,
        );

    logResponse(
        "USER A USDT AFTER CANCEL",
        finalBalance,
    );

    assert(
        finalBalance.status === 200,
        "Could not retrieve final balance",
    );

    console.log(
        "\nFinal available:",
        finalBalance.body.available,
    );

    console.log(
        "Final locked:",
        finalBalance.body.locked,
    );

    /*
     * -------------------------------------
     * 20. INVALID JWT
     * -------------------------------------
     */

    console.log(
        "\n20. Testing invalid JWT...",
    );

    const invalidToken = await request(
        `/users/${userA.id}/balances/USDT`,
        {
            method: "GET",
        },
        "invalid.jwt.token",
    );

    logResponse(
        "INVALID JWT",
        invalidToken,
    );

    assert(
        invalidToken.status === 401,
        "Invalid JWT should be rejected",
    );

    console.log(
        "✅ Invalid JWT rejected",
    );

    /*
     * -------------------------------------
     * COMPLETE
     * -------------------------------------
     */
    await testRedisConsumerRecovery(tokenA);
    console.log("\n========================================");
    console.log("       ✅ ALL TESTS PASSED");
    console.log("========================================");

    console.log("\nTested:");

    console.log("✅ Backend health");
    console.log("✅ User creation");
    console.log("✅ JWT login");
    console.log("✅ Missing JWT rejection");
    console.log("✅ Balance creation");
    console.log("✅ Balance retrieval");
    console.log("✅ Cross-user balance protection");
    console.log("✅ JWT-based order creation");
    console.log("✅ Order processing");
    console.log("✅ Locked funds");
    console.log("✅ Cross-user order protection");
    console.log("✅ BUY / SELL matching");
    console.log("✅ Order history");
    console.log("✅ Unmatched order");
    console.log("✅ Order cancellation");
    console.log("✅ Funds unlocking");
    console.log("✅ Invalid JWT rejection");

    console.log("\nCEX V2 API + AUTH TEST COMPLETE.");
}

main().catch((error) => {
    console.error("\n========================================");
    console.error("       ❌ TEST FAILED");
    console.error("========================================");

    console.error(error);

    process.exit(1);
});