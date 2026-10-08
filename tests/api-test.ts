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
    asset: string;
    side: "BUY" | "SELL";
    type: "LIMIT" | "MARKET";
    quantity: number;
    remainingQty: number;
    price: number | null;
    status: OrderStatus;
};

type RequestResponse = {
    status: number;
    ok: boolean;
    body: any;
};

async function request(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<RequestResponse> {
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

function logResponse(label: string, response: RequestResponse) {
    console.log(`\n${label}`);
    console.log(`Status: ${response.status}`);
    console.log(
        "Response:",
        JSON.stringify(response.body, null, 2),
    );
}

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    logResponse(
        `CREATE BALANCE ${asset}`,
        response,
    );

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
        asset: string;
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
            body: JSON.stringify({
                asset: order.asset,
                side: order.side,
                type: order.type,
                qty: order.qty,
                ...(order.price !== undefined
                    ? { price: order.price }
                    : {}),
            }),
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

async function waitForBalance(
    userId: string,
    asset: string,
    token: string,
    expectedAvailable: number,
    expectedLocked: number,
    timeoutMs = 15000,
) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const response = await getBalance(
            userId,
            asset,
            token,
        );

        if (
            response.ok &&
            Number(response.body.available) ===
                expectedAvailable &&
            Number(response.body.locked) ===
                expectedLocked
        ) {
            return response.body;
        }

        await sleep(500);
    }

    return null;
}

async function waitForOrder(
    orderId: string,
    token: string,
    expectedStatuses: OrderStatus[],
    timeoutMs = 20000,
) {
    const start = Date.now();

    let lastOrder: any = null;

    while (Date.now() - start < timeoutMs) {
        const response = await getOrder(
            orderId,
            token,
        );

        /*
         * The order is inserted by the Redis consumer.
         * Therefore a short period of 404 is expected
         * immediately after POST /orders.
         */
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

        await sleep(500);
    }

    console.log(
        "\nLast order response:",
        JSON.stringify(lastOrder, null, 2),
    );

    return null;
}

async function testAuthentication() {
    console.log("\n========================================");
    console.log("       AUTHENTICATION TEST");
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${crypto.randomUUID()}`;

    const user = await createUser(
        `auth-test-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const token = await login(user);

    assert(
        !!token,
        "JWT token was not returned",
    );

    console.log("\n✅ JWT login works");

    const missingToken = await request(
        `/users/${user.id}/balances/USDT`,
        {
            method: "GET",
        },
    );

    assert(
        missingToken.status === 401,
        `Missing JWT should return 401, got ${missingToken.status}`,
    );

    console.log("✅ Missing JWT rejected");

    const invalidToken = await request(
        `/users/${user.id}/balances/USDT`,
        {
            method: "GET",
        },
        "invalid.jwt.token",
    );

    assert(
        invalidToken.status === 401,
        `Invalid JWT should return 401, got ${invalidToken.status}`,
    );

    console.log("✅ Invalid JWT rejected");

    console.log("\n✅ AUTHENTICATION TEST PASSED");
}

async function testBalanceProtection() {
    console.log("\n========================================");
    console.log("       BALANCE / AUTHORIZATION TEST");
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${crypto.randomUUID()}`;

    const userA = await createUser(
        `balance-a-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const userB = await createUser(
        `balance-b-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const tokenA = await login(userA);
    const tokenB = await login(userB);

    await createBalance(
        userA.id,
        "USDT",
        5000,
        tokenA,
    );

    const ownBalance = await getBalance(
        userA.id,
        "USDT",
        tokenA,
    );

    assert(
        ownBalance.status === 200,
        "User should be able to access own balance",
    );

    assert(
        Number(ownBalance.body.available) === 5000,
        "Incorrect initial USDT balance",
    );

    console.log("✅ Own balance accessible");

    const crossUserBalance = await getBalance(
        userA.id,
        "USDT",
        tokenB,
    );

    assert(
        crossUserBalance.status === 403 ||
            crossUserBalance.status === 401,
        `Cross-user balance access should be rejected, got ${crossUserBalance.status}`,
    );

    console.log("✅ Cross-user balance access rejected");

    console.log("\n✅ BALANCE / AUTHORIZATION TEST PASSED");
}

async function testLimitMatching(
    asset: string,
) {
    console.log("\n========================================");
    console.log(`       ${asset}/USDT LIMIT TEST`);
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${asset.toLowerCase()}-${crypto.randomUUID()}`;

    const buyer = await createUser(
        `${asset.toLowerCase()}-buyer-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const seller = await createUser(
        `${asset.toLowerCase()}-seller-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const buyerToken = await login(buyer);
    const sellerToken = await login(seller);

    const price = 2000;
    const quantity = 1;

    /*
     * BUYER
     *
     * 5000 USDT
     * 0 <asset>
     *
     * SELLER
     *
     * 0 USDT
     * 1 <asset>
     */

    await createBalance(
        buyer.id,
        "USDT",
        5000,
        buyerToken,
    );

    await createBalance(
        buyer.id,
        asset,
        0,
        buyerToken,
    );

    await createBalance(
        seller.id,
        "USDT",
        0,
        sellerToken,
    );

    await createBalance(
        seller.id,
        asset,
        1,
        sellerToken,
    );

    console.log(
        `\nCreating ${asset} LIMIT BUY...`,
    );

    const buyResponse = await createOrder(
        {
            asset,
            side: "BUY",
            type: "LIMIT",
            qty: quantity,
            price,
        },
        buyerToken,
    );

    assert(
        buyResponse.status === 201,
        `${asset} BUY creation failed`,
    );

    const buyOrderId =
        buyResponse.body.orderId;

    assert(
        !!buyOrderId,
        "BUY order ID missing",
    );

    console.log(
        `BUY order: ${buyOrderId}`,
    );

    /*
     * Wait until BUY is actually in the database.
     */
    const buyOpen = await waitForOrder(
        buyOrderId,
        buyerToken,
        ["OPEN"],
    );

    assert(
        !!buyOpen,
        `${asset} BUY did not become OPEN`,
    );

    console.log(
        `\n✅ ${asset} BUY is OPEN`,
    );

    const buyerLockedUSDT =
        await waitForBalance(
            buyer.id,
            "USDT",
            buyerToken,
            5000 - quantity * price,
            quantity * price,
        );

    assert(
        !!buyerLockedUSDT,
        `${asset} BUY did not lock USDT correctly`,
    );

    console.log(
        `✅ ${asset} BUY locked ${quantity * price} USDT`,
    );

    console.log(
        `\nCreating ${asset} LIMIT SELL...`,
    );

    const sellResponse = await createOrder(
        {
            asset,
            side: "SELL",
            type: "LIMIT",
            qty: quantity,
            price,
        },
        sellerToken,
    );

    assert(
        sellResponse.status === 201,
        `${asset} SELL creation failed`,
    );

    const sellOrderId =
        sellResponse.body.orderId;

    assert(
        !!sellOrderId,
        "SELL order ID missing",
    );

    console.log(
        `SELL order: ${sellOrderId}`,
    );

    /*
     * Both orders should eventually become FILLED.
     */
    const finalBuy = await waitForOrder(
        buyOrderId,
        buyerToken,
        ["FILLED"],
    );

    assert(
        !!finalBuy,
        `${asset} BUY did not become FILLED`,
    );

    const finalSell = await waitForOrder(
        sellOrderId,
        sellerToken,
        ["FILLED"],
    );

    assert(
        !!finalSell,
        `${asset} SELL did not become FILLED`,
    );
    if(finalBuy===null || finalSell===null){
        throw new Error("Final buy or final Sell is null")
    }
    assert(
        Number(finalBuy.remainingQty) === 0,
        `${asset} BUY remaining quantity is not 0`,
    );

    assert(
        Number(finalSell.remainingQty) === 0,
        `${asset} SELL remaining quantity is not 0`,
    );

    console.log(
        `\n✅ ${asset}/USDT LIMIT MATCH FILLED`,
    );

    /*
     * Settlement:
     *
     * Buyer:
     *   USDT = 3000 available, 0 locked
     *   asset = 1 available, 0 locked
     *
     * Seller:
     *   USDT = 2000 available, 0 locked
     *   asset = 0 available, 0 locked
     */

    const buyerUSDT = await waitForBalance(
        buyer.id,
        "USDT",
        buyerToken,
        3000,
        0,
    );

    assert(
        !!buyerUSDT,
        `${asset} buyer USDT settlement incorrect`,
    );

    const buyerAsset = await waitForBalance(
        buyer.id,
        asset,
        buyerToken,
        1,
        0,
    );

    assert(
        !!buyerAsset,
        `${asset} buyer asset settlement incorrect`,
    );

    const sellerUSDT = await waitForBalance(
        seller.id,
        "USDT",
        sellerToken,
        2000,
        0,
    );

    assert(
        !!sellerUSDT,
        `${asset} seller USDT settlement incorrect`,
    );

    const sellerAsset = await waitForBalance(
        seller.id,
        asset,
        sellerToken,
        0,
        0,
    );

    assert(
        !!sellerAsset,
        `${asset} seller asset settlement incorrect`,
    );

    console.log(
        `\n✅ ${asset} settlement verified`,
    );

    /*
     * Verify order history.
     */
    const buyerOrders = await getUserOrders(
        buyer.id,
        buyerToken,
    );

    assert(
        buyerOrders.status === 200,
        `${asset} buyer order history failed`,
    );

    console.log(
        `✅ ${asset} order history verified`,
    );
}

async function testCancelOrder(
    asset: string,
) {
    console.log("\n========================================");
    console.log(`       ${asset}/USDT CANCEL TEST`);
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${asset.toLowerCase()}-cancel-${crypto.randomUUID()}`;

    const user = await createUser(
        `cancel-${asset.toLowerCase()}-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const token = await login(user);

    await createBalance(
        user.id,
        "USDT",
        5000,
        token,
    );

    await createBalance(
        user.id,
        asset,
        0,
        token,
    );

    const orderResponse = await createOrder(
        {
            asset,
            side: "BUY",
            type: "LIMIT",
            qty: 1,
            price: 2000,
        },
        token,
    );

    assert(
        orderResponse.status === 201,
        `${asset} cancel-test order creation failed`,
    );

    const orderId =
        orderResponse.body.orderId;

    assert(
        !!orderId,
        "Cancel-test order ID missing",
    );

    const openOrder = await waitForOrder(
        orderId,
        token,
        ["OPEN"],
    );

    assert(
        !!openOrder,
        `${asset} cancel-test order did not become OPEN`,
    );

    const lockedBalance =
        await waitForBalance(
            user.id,
            "USDT",
            token,
            3000,
            2000,
        );

    assert(
        !!lockedBalance,
        `${asset} BUY did not lock USDT`,
    );

    console.log(
        `✅ ${asset} order locked 2000 USDT`,
    );

    const cancelResponse = await cancelOrder(
        orderId,
        token,
    );

    assert(
        cancelResponse.status === 200,
        `${asset} order cancellation failed`,
    );

    const cancelledOrder = await waitForOrder(
        orderId,
        token,
        ["CANCELLED"],
    );

    assert(
        !!cancelledOrder,
        `${asset} order did not become CANCELLED`,
    );

    const unlockedBalance =
        await waitForBalance(
            user.id,
            "USDT",
            token,
            5000,
            0,
        );

    assert(
        !!unlockedBalance,
        `${asset} cancellation did not unlock USDT`,
    );

    console.log(
        `\n✅ ${asset} cancellation and unlock verified`,
    );
}

async function testMarketBuy(
    asset: string,
) {
    console.log("\n========================================");
    console.log(`       ${asset}/USDT MARKET BUY TEST`);
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${asset.toLowerCase()}-market-buy-${crypto.randomUUID()}`;

    const buyer = await createUser(
        `market-buy-${asset.toLowerCase()}-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const seller = await createUser(
        `market-buy-seller-${asset.toLowerCase()}-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const buyerToken = await login(buyer);
    const sellerToken = await login(seller);

    const price = 2000;

    await createBalance(
        buyer.id,
        "USDT",
        5000,
        buyerToken,
    );

    await createBalance(
        buyer.id,
        asset,
        0,
        buyerToken,
    );

    await createBalance(
        seller.id,
        "USDT",
        0,
        sellerToken,
    );

    await createBalance(
        seller.id,
        asset,
        1,
        sellerToken,
    );

    /*
     * First create a LIMIT SELL.
     *
     * 1 ETH/SOL @ 2000 USDT
     */
    const sellResponse = await createOrder(
        {
            asset,
            side: "SELL",
            type: "LIMIT",
            qty: 1,
            price,
        },
        sellerToken,
    );

    assert(
        sellResponse.status === 201,
        `${asset} market-buy SELL creation failed`,
    );

    const sellOrderId =
        sellResponse.body.orderId;

    const sellOpen = await waitForOrder(
        sellOrderId,
        sellerToken,
        ["OPEN"],
    );

    assert(
        !!sellOpen,
        `${asset} market-buy SELL did not become OPEN`,
    );

    console.log(
        `✅ ${asset} SELL is OPEN`,
    );

    /*
     * MARKET BUY consumes the SELL.
     */
    const marketBuyResponse =
        await createOrder(
            {
                asset,
                side: "BUY",
                type: "MARKET",
                qty: 0.5,
            },
            buyerToken,
        );

    assert(
        marketBuyResponse.status === 201,
        `${asset} MARKET BUY creation failed`,
    );

    const marketBuyOrderId =
        marketBuyResponse.body.orderId;

    assert(
        !!marketBuyOrderId,
        `${asset} MARKET BUY order ID missing`,
    );

    const marketBuyOrder =
        await waitForOrder(
            marketBuyOrderId,
            buyerToken,
            ["FILLED"],
        );

    assert(
        !!marketBuyOrder,
        `${asset} MARKET BUY did not become FILLED`,
    );

    const finalSell = await waitForOrder(
        sellOrderId,
        sellerToken,
        ["PARTIALLY_FILLED", "FILLED"],
    );

    assert(
        !!finalSell,
        `${asset} SELL did not become partially/fully filled`,
    );
    if(finalSell===null){
        throw new Error("Final sell is null")
    }
    assert(
        Number(finalSell.remainingQty) === 0.5,
        `${asset} SELL should have 0.5 remaining`,
    );

    console.log(
        `\n✅ ${asset} MARKET BUY matched 0.5 ${asset}`,
    );

    /*
     * Cancel remaining SELL so this test
     * does not leave an active order.
     */
    const cancelResponse = await cancelOrder(
        sellOrderId,
        sellerToken,
    );

    assert(
        cancelResponse.status === 200,
        `${asset} remaining SELL cancellation failed`,
    );

    const cancelledSell =
        await waitForOrder(
            sellOrderId,
            sellerToken,
            ["CANCELLED"],
        );

    assert(
        !!cancelledSell,
        `${asset} remaining SELL did not become CANCELLED`,
    );

    const sellerFinalAsset =
        await waitForBalance(
            seller.id,
            asset,
            sellerToken,
            0.5,
            0,
        );

    assert(
        !!sellerFinalAsset,
        `${asset} remaining balance was not unlocked`,
    );

    console.log(
        `✅ ${asset} remaining SELL balance unlocked`,
    );

    /*
     * Buyer should receive 0.5 asset
     * and spend 1000 USDT.
     */
    const buyerFinalAsset =
        await waitForBalance(
            buyer.id,
            asset,
            buyerToken,
            0.5,
            0,
        );

    assert(
        !!buyerFinalAsset,
        `${asset} MARKET BUY settlement failed`,
    );

    const buyerFinalUSDT =
        await waitForBalance(
            buyer.id,
            "USDT",
            buyerToken,
            4000,
            0,
        );

    assert(
        !!buyerFinalUSDT,
        `${asset} MARKET BUY USDT settlement failed`,
    );

    console.log(
        `\n✅ ${asset} MARKET BUY TEST PASSED`,
    );
}

async function testMarketSell(
    asset: string,
) {
    console.log("\n========================================");
    console.log(`       ${asset}/USDT MARKET SELL TEST`);
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${asset.toLowerCase()}-market-sell-${crypto.randomUUID()}`;

    const buyer = await createUser(
        `market-sell-buyer-${asset.toLowerCase()}-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const seller = await createUser(
        `market-sell-${asset.toLowerCase()}-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const buyerToken = await login(buyer);
    const sellerToken = await login(seller);

    const price = 2000;

    await createBalance(
        buyer.id,
        "USDT",
        5000,
        buyerToken,
    );

    await createBalance(
        buyer.id,
        asset,
        0,
        buyerToken,
    );

    await createBalance(
        seller.id,
        "USDT",
        0,
        sellerToken,
    );

    await createBalance(
        seller.id,
        asset,
        1,
        sellerToken,
    );

    /*
     * LIMIT BUY provides liquidity.
     */
    const buyResponse = await createOrder(
        {
            asset,
            side: "BUY",
            type: "LIMIT",
            qty: 1,
            price,
        },
        buyerToken,
    );

    assert(
        buyResponse.status === 201,
        `${asset} market-sell BUY creation failed`,
    );

    const buyOrderId =
        buyResponse.body.orderId;

    const buyOpen = await waitForOrder(
        buyOrderId,
        buyerToken,
        ["OPEN"],
    );

    assert(
        !!buyOpen,
        `${asset} market-sell BUY did not become OPEN`,
    );

    console.log(
        `✅ ${asset} BUY is OPEN`,
    );

    /*
     * MARKET SELL consumes 0.5 asset.
     */
    const marketSellResponse =
        await createOrder(
            {
                asset,
                side: "SELL",
                type: "MARKET",
                qty: 0.5,
            },
            sellerToken,
        );

    assert(
        marketSellResponse.status === 201,
        `${asset} MARKET SELL creation failed`,
    );

    const marketSellOrderId =
        marketSellResponse.body.orderId;

    assert(
        !!marketSellOrderId,
        `${asset} MARKET SELL order ID missing`,
    );

    const marketSellOrder =
        await waitForOrder(
            marketSellOrderId,
            sellerToken,
            ["FILLED"],
        );

    assert(
        !!marketSellOrder,
        `${asset} MARKET SELL did not become FILLED`,
    );

    const finalBuy = await waitForOrder(
        buyOrderId,
        buyerToken,
        ["PARTIALLY_FILLED", "FILLED"],
    );

    assert(
        !!finalBuy,
        `${asset} BUY did not become partially/fully filled`,
    );
    if(finalBuy===null){
        throw new Error("Final buy is null")
    }
    assert(
        Number(finalBuy.remainingQty) === 0.5,
        `${asset} BUY should have 0.5 remaining`,
    );

    console.log(
        `\n✅ ${asset} MARKET SELL matched 0.5 ${asset}`,
    );

    /*
     * Cancel remaining BUY.
     */
    const cancelResponse = await cancelOrder(
        buyOrderId,
        buyerToken,
    );

    assert(
        cancelResponse.status === 200,
        `${asset} remaining BUY cancellation failed`,
    );

    const cancelledBuy =
        await waitForOrder(
            buyOrderId,
            buyerToken,
            ["CANCELLED"],
        );

    assert(
        !!cancelledBuy,
        `${asset} remaining BUY did not become CANCELLED`,
    );

    const buyerFinalUSDT =
        await waitForBalance(
            buyer.id,
            "USDT",
            buyerToken,
            4000,
            0,
        );

    assert(
        !!buyerFinalUSDT,
        `${asset} remaining BUY USDT was not unlocked`,
    );

    /*
     * Seller:
     *
     * 0.5 asset remains
     * 1000 USDT received
     */
    const sellerFinalAsset =
        await waitForBalance(
            seller.id,
            asset,
            sellerToken,
            0.5,
            0,
        );

    assert(
        !!sellerFinalAsset,
        `${asset} MARKET SELL asset settlement failed`,
    );

    const sellerFinalUSDT =
        await waitForBalance(
            seller.id,
            "USDT",
            sellerToken,
            1000,
            0,
        );

    assert(
        !!sellerFinalUSDT,
        `${asset} MARKET SELL USDT settlement failed`,
    );

    console.log(
        `\n✅ ${asset} MARKET SELL TEST PASSED`,
    );
}

async function testCrossUserOrderProtection() {
    console.log("\n========================================");
    console.log("       ORDER AUTHORIZATION TEST");
    console.log("========================================");

    const uniqueId =
        `${Date.now()}-${crypto.randomUUID()}`;

    const owner = await createUser(
        `order-owner-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const otherUser = await createUser(
        `order-other-${uniqueId}@test.com`,
        "TestPassword123!",
    );

    const ownerToken = await login(owner);
    const otherToken = await login(otherUser);

    await createBalance(
        owner.id,
        "USDT",
        5000,
        ownerToken,
    );

    await createBalance(
        owner.id,
        "ETH",
        0,
        ownerToken,
    );

    const response = await createOrder(
        {
            asset: "ETH",
            side: "BUY",
            type: "LIMIT",
            qty: 1,
            price: 2000,
        },
        ownerToken,
    );

    assert(
        response.status === 201,
        "Order creation failed",
    );

    const orderId = response.body.orderId;

    const openOrder = await waitForOrder(
        orderId,
        ownerToken,
        ["OPEN"],
    );

    assert(
        !!openOrder,
        "Owner order did not become OPEN",
    );

    const otherUserResponse =
        await getOrder(
            orderId,
            otherToken,
        );

    assert(
        otherUserResponse.status === 403 ||
            otherUserResponse.status === 401 ||
        otherUserResponse.status === 404,
        `Other user should not access order, got ${otherUserResponse.status}`,
    );

    console.log(
        "✅ Cross-user order access rejected",
    );

    /*
     * Clean up the open order.
     */
    const cancelResponse = await cancelOrder(
        orderId,
        ownerToken,
    );

    assert(
        cancelResponse.status === 200,
        "Cleanup cancellation failed",
    );

    console.log(
        "\n✅ ORDER AUTHORIZATION TEST PASSED",
    );
}

async function main() {
    console.log("\n========================================");
    console.log("       CEX API TEST SUITE");
    console.log("========================================");

    console.log(`\nBackend: ${BASE_URL}`);

    /*
     * Basic authentication and authorization.
     */
    await testAuthentication();

    await testBalanceProtection();

    /*
     * Core multi-asset LIMIT matching.
     *
     * USDT is always the quote currency.
     */
    await testLimitMatching("ETH");

    await testLimitMatching("SOL");

    /*
     * Cancellation and balance unlocking.
     */
    await testCancelOrder("ETH");

    await testCancelOrder("SOL");

    /*
     * MARKET BUY / SELL.
     */
    await testMarketBuy("ETH");

    await testMarketSell("ETH");

    await testMarketBuy("SOL");

    await testMarketSell("SOL");

    /*
     * Order authorization.
     */
    await testCrossUserOrderProtection();

    console.log("\n========================================");
    console.log("       ✅ ALL API TESTS PASSED");
    console.log("========================================");

    console.log("\nVerified:");

    console.log("✅ JWT authentication");
    console.log("✅ Missing JWT rejection");
    console.log("✅ Invalid JWT rejection");
    console.log("✅ Balance creation");
    console.log("✅ Balance retrieval");
    console.log("✅ Cross-user balance protection");
    console.log("✅ ETH/USDT LIMIT BUY");
    console.log("✅ ETH/USDT LIMIT SELL");
    console.log("✅ ETH/USDT settlement");
    console.log("✅ SOL/USDT LIMIT BUY");
    console.log("✅ SOL/USDT LIMIT SELL");
    console.log("✅ SOL/USDT settlement");
    console.log("✅ ETH order cancellation");
    console.log("✅ SOL order cancellation");
    console.log("✅ ETH MARKET BUY");
    console.log("✅ ETH MARKET SELL");
    console.log("✅ SOL MARKET BUY");
    console.log("✅ SOL MARKET SELL");
    console.log("✅ Balance unlocking");
    console.log("✅ Cross-user order protection");
}

main().catch((error) => {
    console.error("\n========================================");
    console.error("       ❌ API TEST FAILED");
    console.error("========================================");

    console.error(error);

    process.exit(1);
});