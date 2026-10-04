import { UserScalarFieldEnum } from "../generated/prisma/internal/prismaNamespace";

const BASE_URL = "http://localhost:3000";

type User = {
    id: string;
    email: string;
    password: string;
};

type LoginResponse = {
    token: string;
};

type ApiResponse = {
    status: number;
    ok: boolean;
    body: unknown;
};

type BalanceResponse = {
    id: string;
    userId: string;
    asset: string;
    available: number | string;
    locked: number | string;
};

type ErrorResponse = {
    error?: string;
};

function assert(
    condition: boolean,
    message: string,
): asserts condition {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

function isRecord(
    value: unknown,
): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null
    );
}

function getErrorMessage(
    body: unknown,
): string {
    if (
        isRecord(body) &&
        typeof body.error === "string"
    ) {
        return body.error;
    }

    return "";
}

function getString(
    body: unknown,
    key: string,
): string | null {
    if (
        !isRecord(body) ||
        typeof body[key] !== "string"
    ) {
        return null;
    }

    return body[key];
}

async function request(
    path: string,
    options: RequestInit = {},
    token?: string,
): Promise<ApiResponse> {
    const headers =
        new Headers(options.headers);

    headers.set(
        "Content-Type",
        "application/json",
    );

    if (token !== undefined) {
        headers.set(
            "Authorization",
            `Bearer ${token}`,
        );
    }

    const response =
        await fetch(
            `${BASE_URL}${path}`,
            {
                ...options,
                headers,
            },
        );

    const text =
        await response.text();

    let body: unknown = null;

    if (text.length > 0) {
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
    }

    return {
        status: response.status,
        ok: response.ok,
        body,
    };
}

function logResponse(
    label: string,
    response: ApiResponse,
): void {
    console.log(`\n${label}`);
    console.log(
        "Status:",
        response.status,
    );
    console.log(
        "Response:",
        JSON.stringify(
            response.body,
            null,
            2,
        ),
    );
}

async function createUser(
    email: string,
    password: string,
): Promise<User> {
    const response =
        await request(
            "/users",
            {
                method: "POST",
                body: JSON.stringify({
                    email,
                    password,
                }),
            },
        );

    logResponse(
        "CREATE USER",
        response,
    );

    assert(
        response.status === 201,
        `User creation failed with status ${response.status}`,
    );

    const id =
        getString(
            response.body,
            "id",
        );

    assert(
        id !== null,
        "User creation did not return an ID",
    );

    return {
        id,
        email,
        password,
    };
}

async function login(
    user: User,
): Promise<string> {
    const response =
        await request(
            "/auth/login",
            {
                method: "POST",
                body: JSON.stringify({
                    email: user.email,
                    password: user.password,
                }),
            },
        );

    logResponse(
        "LOGIN",
        response,
    );

    assert(
        response.status === 200,
        `Login failed with status ${response.status}`,
    );

    const token =
        getString(
            response.body,
            "token",
        );

    assert(
        token !== null,
        "Login did not return JWT",
    );

    const loginResponse: LoginResponse = {
        token,
    };

    return loginResponse.token;
}

async function createBalance(
    userId: string,
    asset: string,
    amount: number,
    token: string,
): Promise<BalanceResponse> {
    const response =
        await request(
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
        `CREATE ${asset} BALANCE`,
        response,
    );

    assert(
        response.status === 201,
        `Failed to create ${asset} balance`,
    );

    assert(
        isRecord(response.body),
        "Balance response should be an object",
    );

    const balance =
        response.body;

    assert(
        typeof balance.id === "string",
        "Balance response missing id",
    );

    assert(
        typeof balance.userId === "string",
        "Balance response missing userId",
    );

    assert(
        typeof balance.asset === "string",
        "Balance response missing asset",
    );

    assert(
        typeof balance.available === "number" ||
        typeof balance.available === "string",
        "Balance response missing available amount",
    );

    assert(
        typeof balance.locked === "number" ||
        typeof balance.locked === "string",
        "Balance response missing locked amount",
    );

    return {
        id: balance.id,
        userId: balance.userId,
        asset: balance.asset,
        available: balance.available,
        locked: balance.locked,
    };
}

async function getBalance(
    userId: string,
    asset: string,
    token: string,
): Promise<ApiResponse> {
    return request(
        `/users/${userId}/balances/${asset}`,
        {
            method: "GET",
        },
        token,
    );
}

async function createOrder(
    order: Record<string, unknown>,
    token: string,
): Promise<ApiResponse> {
    return request(
        "/orders",
        {
            method: "POST",
            body: JSON.stringify(order),
        },
        token,
    );
}

async function testBackendHealth(): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 1: BACKEND HEALTH");
    console.log("========================================");

    const response =
        await request("/");

    logResponse(
        "GET /",
        response,
    );

    assert(
        response.status === 200,
        "Backend health check failed",
    );

    console.log(
        "✅ Backend is running",
    );
}

async function testMissingJwt(
    userId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 2: MISSING JWT");
    console.log("========================================");

    const response =
        await request(
            `/users/${userId}/balances/USDT`,
        );

    logResponse(
        "REQUEST WITHOUT JWT",
        response,
    );

    assert(
        response.status === 401,
        `Expected 401, got ${response.status}`,
    );

    console.log(
        "✅ Missing JWT rejected",
    );
}

async function testMalformedJwt(
    userId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 3: MALFORMED JWT");
    console.log("========================================");

    const response =
        await request(
            `/users/${userId}/balances/USDT`,
            {
                method: "GET",
            },
            "this-is-not-a-valid-jwt",
        );

    logResponse(
        "MALFORMED JWT",
        response,
    );

    assert(
        response.status === 401,
        `Expected 401, got ${response.status}`,
    );

    console.log(
        "✅ Malformed JWT rejected",
    );
}

async function testInvalidAuthorizationFormat(
    userId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 4: INVALID AUTHORIZATION FORMAT",
    );
    console.log("========================================");

    const response =
        await request(
            `/users/${userId}/balances/USDT`,
            {
                method: "GET",
                headers: {
                    Authorization:
                        "Basic invalid-token",
                },
            },
        );

    logResponse(
        "INVALID AUTH FORMAT",
        response,
    );

    assert(
        response.status === 401,
        `Expected 401, got ${response.status}`,
    );

    console.log(
        "✅ Invalid authorization format rejected",
    );
}

async function testInvalidSide(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 5: INVALID ORDER SIDE");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "INVALID",
                type: "LIMIT",
                qty: 1,
                price: 100,
            },
            token,
        );

    logResponse(
        "INVALID SIDE",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for invalid side, got ${response.status}`,
    );

    console.log(
        "✅ Invalid order side rejected",
    );
}

async function testInvalidType(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 6: INVALID ORDER TYPE");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "INVALID",
                qty: 1,
                price: 100,
            },
            token,
        );

    logResponse(
        "INVALID TYPE",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for invalid type, got ${response.status}`,
    );

    console.log(
        "✅ Invalid order type rejected",
    );
}

async function testZeroQuantity(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 7: ZERO QUANTITY");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 0,
                price: 100,
            },
            token,
        );

    logResponse(
        "ZERO QUANTITY",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for zero quantity, got ${response.status}`,
    );

    console.log(
        "✅ Zero quantity rejected",
    );
}

async function testNegativeQuantity(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 8: NEGATIVE QUANTITY");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: -1,
                price: 100,
            },
            token,
        );

    logResponse(
        "NEGATIVE QUANTITY",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for negative quantity, got ${response.status}`,
    );

    console.log(
        "✅ Negative quantity rejected",
    );
}

async function testMissingPrice(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 9: LIMIT ORDER WITHOUT PRICE");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
            },
            token,
        );

    logResponse(
        "LIMIT WITHOUT PRICE",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for missing LIMIT price, got ${response.status}`,
    );

    console.log(
        "✅ LIMIT order without price rejected",
    );
}

async function testZeroPrice(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 10: ZERO PRICE");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price: 0,
            },
            token,
        );

    logResponse(
        "ZERO PRICE",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for zero price, got ${response.status}`,
    );

    console.log(
        "✅ Zero price rejected",
    );
}

async function testNegativePrice(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 11: NEGATIVE PRICE");
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price: -100,
            },
            token,
        );

    logResponse(
        "NEGATIVE PRICE",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for negative price, got ${response.status}`,
    );

    console.log(
        "✅ Negative price rejected",
    );
}

async function testMarketOrderWithPrice(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 12: MARKET ORDER WITH PRICE",
    );
    console.log("========================================");

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "MARKET",
                qty: 1,
                price: 100,
            },
            token,
        );

    logResponse(
        "MARKET ORDER WITH PRICE",
        response,
    );

    assert(
        response.status === 400,
        `Expected 400 for MARKET order with price, got ${response.status}`,
    );

    console.log(
        "✅ MARKET order with price rejected",
    );
}

async function testInsufficientBalance(
    userId: string,
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 13: INSUFFICIENT BALANCE",
    );
    console.log("========================================");

    const before =
        await getBalance(
            userId,
            "USDT",
            token,
        );

    logResponse(
        "BALANCE BEFORE INSUFFICIENT ORDER",
        before,
    );

    assert(
        before.status === 200,
        "Could not read balance before insufficient-balance test",
    );

    assert(
        isRecord(before.body),
        "Invalid balance response",
    );

    const beforeAvailable =
        Number(
            before.body.available,
        );

    const beforeLocked =
        Number(
            before.body.locked,
        );

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1000,
                price: 1000,
            },
            token,
        );

    logResponse(
        "INSUFFICIENT BALANCE ORDER",
        response,
    );

    /*
     * The API only validates the request structure.
     *
     * Balance validation happens inside the engine
     * when lockBalance() is called.
     */
    assert(
        response.status === 201,
        `Expected order to be queued with 201, got ${response.status}`,
    );

    const orderId =
        getString(
            response.body,
            "orderId",
        );

    assert(
        orderId !== null,
        "Queued order did not return orderId",
    );

    console.log(
        "Order queued:",
        orderId,
    );

    /*
     * Give the Redis consumer/engine time to process
     * the queued order.
     */
    await new Promise(
        (
            resolve,
        ) =>
            setTimeout(
                resolve,
                1500,
            ),
    );

    const orderResponse =
        await request(
            `/orders/${orderId}`,
            {
                method: "GET",
            },
            token,
        );

    logResponse(
        "ORDER AFTER ENGINE PROCESSING",
        orderResponse,
    );

    /*
     * createOrderInDb() performs the balance check
     * before creating the Order record.
     *
     * Therefore an insufficient-balance order
     * should not exist in the database.
     */
    assert(
        orderResponse.status === 404,
        `Expected rejected order to not exist, got ${orderResponse.status}`,
    );

    const after =
        await getBalance(
            userId,
            "USDT",
            token,
        );

    logResponse(
        "BALANCE AFTER INSUFFICIENT ORDER",
        after,
    );

    assert(
        after.status === 200,
        "Could not read balance after insufficient-balance test",
    );

    assert(
        isRecord(after.body),
        "Invalid balance response after insufficient order",
    );

    const afterAvailable =
        Number(
            after.body.available,
        );

    const afterLocked =
        Number(
            after.body.locked,
        );

    assert(
        afterAvailable === beforeAvailable,
        `Available balance changed from ${beforeAvailable} to ${afterAvailable}`,
    );

    assert(
        afterLocked === beforeLocked,
        `Locked balance changed from ${beforeLocked} to ${afterLocked}`,
    );

    console.log(
        "Before available:",
        beforeAvailable,
    );

    console.log(
        "After available:",
        afterAvailable,
    );

    console.log(
        "Before locked:",
        beforeLocked,
    );

    console.log(
        "After locked:",
        afterLocked,
    );

    console.log(
        "✅ Insufficient-balance order rejected by engine",
    );

    console.log(
        "✅ No funds were locked",
    );
}

async function testRejectedOrderDoesNotLockFunds(
    userId: string,
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 14: REJECTED ORDER DOES NOT LOCK FUNDS",
    );
    console.log("========================================");

    const before =
        await getBalance(
            userId,
            "USDT",
            token,
        );

    logResponse(
        "BALANCE BEFORE REJECTED ORDER",
        before,
    );

    assert(
        before.status === 200,
        "Could not read balance before rejected order",
    );

    assert(
        isRecord(before.body),
        "Invalid balance response",
    );

    const beforeAvailable =
        Number(
            before.body.available,
        );

    const beforeLocked =
        Number(
            before.body.locked,
        );

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 999999,
                price: 999999,
            },
            token,
        );

    logResponse(
        "REJECTED ORDER",
        response,
    );

    assert(
        response.status === 201,
        `Expected order to be queued with 201, got ${response.status}`,
    );

    const orderId =
        getString(
            response.body,
            "orderId",
        );

    assert(
        orderId !== null,
        "Queued order did not return orderId",
    );

    await new Promise(
        (
            resolve,
        ) =>
            setTimeout(
                resolve,
                1500,
            ),
    );

    const orderResponse =
        await request(
            `/orders/${orderId}`,
            {
                method: "GET",
            },
            token,
        );

    logResponse(
        "REJECTED ORDER AFTER ENGINE PROCESSING",
        orderResponse,
    );

    assert(
        orderResponse.status === 404,
        `Expected rejected order to not exist, got ${orderResponse.status}`,
    );

    const after =
        await getBalance(
            userId,
            "USDT",
            token,
        );

    logResponse(
        "BALANCE AFTER REJECTED ORDER",
        after,
    );

    assert(
        after.status === 200,
        "Could not read balance after rejected order",
    );

    assert(
        isRecord(after.body),
        "Invalid balance response after rejected order",
    );

    const afterAvailable =
        Number(
            after.body.available,
        );

    const afterLocked =
        Number(
            after.body.locked,
        );

    assert(
        afterLocked === beforeLocked,
        `Locked balance changed from ${beforeLocked} to ${afterLocked}`,
    );

    assert(
        afterAvailable === beforeAvailable,
        `Available balance changed from ${beforeAvailable} to ${afterAvailable}`,
    );

    console.log(
        "Before available:",
        beforeAvailable,
    );

    console.log(
        "After available:",
        afterAvailable,
    );

    console.log(
        "Before locked:",
        beforeLocked,
    );

    console.log(
        "After locked:",
        afterLocked,
    );

    console.log(
        "✅ Rejected order did not lock funds",
    );
}

async function testInvalidCancellation(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 15: INVALID CANCELLATION",
    );
    console.log("========================================");

    const fakeOrderId =
        crypto.randomUUID();

    const response =
        await request(
            `/orders/${fakeOrderId}`,
            {
                method: "DELETE",
            },
            token,
        );

    logResponse(
        "CANCEL NON-EXISTENT ORDER",
        response,
    );

    assert(
        response.status === 404,
        `Expected 404 for non-existent order cancellation, got ${response.status}`,
    );

    console.log(
        "✅ Invalid cancellation rejected",
    );
}

async function testCancelOtherUsersOrder(
    userA: User,
    tokenA: string,
    userB: User,
    tokenB: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 16: CANCEL ANOTHER USER'S ORDER",
    );
    console.log("========================================");

    /*
     * User A creates a very cheap BUY order.
     * User B then attempts to cancel it.
     *
     * We use an isolated price so it should remain
     * OPEN and available for the cancellation test.
     */

    const response =
        await createOrder(
            {
                side: "BUY",
                type: "LIMIT",
                qty: 1,
                price: 0.000001,
            },
            tokenA,
        );

    logResponse(
        "USER A CREATE ORDER",
        response,
    );

    assert(
        response.status === 201,
        `Expected order creation to succeed, got ${response.status}`,
    );

    const orderId =
        getString(
            response.body,
            "orderId",
        );

    assert(
        orderId !== null,
        "Order ID missing",
    );

    /*
     * Give the Redis consumer a short amount of time
     * to process the order before User B attempts
     * cancellation.
     */

    await new Promise(
        (
            resolve,
        ) =>
            setTimeout(
                resolve,
                1000,
            ),
    );

    const cancelResponse =
        await request(
            `/orders/${orderId}`,
            {
                method: "DELETE",
            },
            tokenB,
        );

    logResponse(
        "USER B CANCEL USER A ORDER",
        cancelResponse,
    );

    assert(
        cancelResponse.status === 403 ||
        cancelResponse.status === 404,
        `Expected 403 or 404, got ${cancelResponse.status}`,
    );

    console.log(
        "User A:",
        userA.id,
    );

    console.log(
        "User B:",
        userB.id,
    );

    console.log(
        "✅ Cross-user cancellation rejected",
    );
}

async function testMissingOrderFields(
    token: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 17: MISSING ORDER FIELDS",
    );
    console.log("========================================");

    const cases: Record<
        string,
        Record<string, unknown>
    > = {
        missingSide: {
            type: "LIMIT",
            qty: 1,
            price: 100,
        },
        missingType: {
            side: "BUY",
            qty: 1,
            price: 100,
        },
        missingQty: {
            side: "BUY",
            type: "LIMIT",
            price: 100,
        },
    };

    for (
        const [name, order] of
        Object.entries(cases)
    ) {
        const response =
            await createOrder(
                order,
                token,
            );

        logResponse(
            `MISSING FIELD: ${name}`,
            response,
        );

        assert(
            response.status === 400,
            `${name} should return 400, got ${response.status}`,
        );
    }

    console.log(
        "✅ Missing required fields rejected",
    );
}

async function testDuplicateOrderId(): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 18: DUPLICATE ORDER ID",
    );
    console.log("========================================");

    console.log(
        "⚠️ POST /orders generates order IDs internally.",
    );

    console.log(
        "This case cannot be tested through the current HTTP API.",
    );

    console.log(
        "It should be covered by the engine/database test for createOrderInDb().",
    );

    console.log(
        "✅ Duplicate-ID API limitation documented",
    );
}

async function main(): Promise<void> {
    console.log(
        "========================================",
    );

    console.log(
        "   CEX V2 API VALIDATION TEST",
    );

    console.log(
        "========================================",
    );

    try {
        /*
         * -------------------------------
         * BACKEND
         * -------------------------------
         */

        await testBackendHealth();

        /*
         * -------------------------------
         * TEST USER
         * -------------------------------
         */

        const uniqueId =
            `${Date.now()}-${crypto.randomUUID()}`;

        const user =
            await createUser(
                `validation-${uniqueId}@test.com`,
                "TestPassword123!",
            );

        const token =
            await login(user);

        /*
         * -------------------------------
         * AUTH
         * -------------------------------
         */

        await testMissingJwt(
            user.id,
        );

        await testMalformedJwt(
            user.id,
        );

        await testInvalidAuthorizationFormat(
            user.id,
        );

        /*
         * -------------------------------
         * BALANCE
         * -------------------------------
         */

        await createBalance(
            user.id,
            "USDT",
            1000,
            token,
        );

        await createBalance(
            user.id,
            "BTC",
            1,
            token,
        );

        /*
         * -------------------------------
         * ORDER VALIDATION
         * -------------------------------
         */

        await testInvalidSide(
            token,
        );

        await testInvalidType(
            token,
        );

        await testZeroQuantity(
            token,
        );

        await testNegativeQuantity(
            token,
        );

        await testMissingPrice(
            token,
        );

        await testZeroPrice(
            token,
        );

        await testNegativePrice(
            token,
        );

        await testMarketOrderWithPrice(
            token,
        );

        await testInsufficientBalance(user.id ,
            token,
        );

        await testMissingOrderFields(
            token,
        );

        /*
         * -------------------------------
         * BALANCE SAFETY
         * -------------------------------
         */

        await testRejectedOrderDoesNotLockFunds(
            user.id,
            token,
        );

        /*
         * -------------------------------
         * CANCELLATION
         * -------------------------------
         */

        await testInvalidCancellation(
            token,
        );

        /*
         * Create second user for
         * cross-user cancellation test.
         */

        const secondUser =
            await createUser(
                `validation-second-${uniqueId}@test.com`,
                "TestPassword123!",
            );

        const secondToken =
            await login(
                secondUser,
            );

        await createBalance(
            secondUser.id,
            "USDT",
            1000,
            secondToken,
        );

        await createBalance(
            secondUser.id,
            "BTC",
            1,
            secondToken,
        );

        await testCancelOtherUsersOrder(
            user,
            token,
            secondUser,
            secondToken,
        );

        /*
         * -------------------------------
         * DUPLICATE ID
         * -------------------------------
         */

        await testDuplicateOrderId();

        /*
         * -------------------------------
         * COMPLETE
         * -------------------------------
         */

        console.log(
            "\n========================================",
        );

        console.log(
            "   ✅ API VALIDATION TEST COMPLETE",
        );

        console.log(
            "========================================",
        );

    } catch (error: unknown) {
        console.error(
            "\n========================================",
        );

        console.error(
            "   ❌ API VALIDATION TEST FAILED",
        );

        console.error(
            "========================================",
        );

        console.error(error);

        process.exit(1);
    }
}

main();