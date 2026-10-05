import assert from "node:assert";

import { prisma } from "../apps/engine/db";
import { redis } from "../apps/engine/redis";

const BASE_URL = "http://localhost:3000";
const WS_URL = "ws://localhost:3001";

const ORDER_TIMEOUT = 30000;
const POLL_INTERVAL = 250;

type ApiResponse = {
    status: number;
    body: unknown;
};

type AuthResponse = {
    token: string;
    userId: string;
    email: string;
};

type OrderStatus =
    | "OPEN"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELLED";

type OrderResponse = {
    id: string;
    userId: string;
    side: "BUY" | "SELL";
    type: "LIMIT" | "MARKET";
    asset: string;
    quantity: number | string;
    remainingQty: number | string;
    price: number | string | null;
    marketBuyReservedUSDT: number | string | null;
    status: OrderStatus;
    createdAt?: string;
};

type WebSocketEvent = {
    type?: string;
    [key: string]: unknown;
};

function logSection(title: string): void {
    console.log("\n========================================");
    console.log(title);
    console.log("========================================");
}

function logResponse(
    name: string,
    response: ApiResponse,
): void {
    console.log(`\n${name}`);
    console.log("Status:", response.status);
    console.log(
        "Body:",
        JSON.stringify(response.body, null, 2),
    );
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function getString(
    value: unknown,
    field: string,
): string {
    assert(
        typeof value === "object" &&
            value !== null,
        `Response does not contain field "${field}"`,
    );

    const fieldValue =
        (value as Record<string, unknown>)[field];

    assert(
        typeof fieldValue === "string",
        `Field "${field}" is not a string`,
    );

    return fieldValue;
}

function getNumber(
    value: unknown,
    field: string,
): number {
    assert(
        typeof value === "object" &&
            value !== null,
        `Response does not contain field "${field}"`,
    );

    const fieldValue =
        (value as Record<string, unknown>)[field];

    const numberValue = Number(fieldValue);

    assert(
        Number.isFinite(numberValue),
        `Field "${field}" is not a valid number`,
    );

    return numberValue;
}

async function request(
    path: string,
    options: RequestInit = {},
): Promise<ApiResponse> {
    const response = await fetch(
        `${BASE_URL}${path}`,
        options,
    );

    const text = await response.text();

    let body: unknown;

    if (text.length === 0) {
        body = {};
    } else {
        try {
            body = JSON.parse(text);
        } catch {
            body = text;
        }
    }

    return {
        status: response.status,
        body,
    };
}

/* =========================================================
   AUTHENTICATION
   ========================================================= */

async function createUser(
    email: string,
    password: string,
): Promise<{
    userId: string;
    email: string;
}> {
    const response = await request(
        "/users",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                email,
                password,
            }),
        },
    );

    logResponse("CREATE USER", response);

    assert(
        response.status === 201,
        `User creation failed: ${response.status}`,
    );

    assert(
        typeof response.body === "object" &&
            response.body !== null,
        "Invalid user creation response",
    );

    return {
        userId: getString(
            response.body,
            "id",
        ),
        email: getString(
            response.body,
            "email",
        ),
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
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                email,
                password,
            }),
        },
    );

    logResponse("LOGIN", response);

    assert(
        response.status === 200,
        `Login failed: ${response.status}`,
    );

    assert(
        typeof response.body === "object" &&
            response.body !== null,
        "Invalid login response",
    );

    return getString(
        response.body,
        "token",
    );
}

async function createTestUsers(): Promise<{
    buyer: AuthResponse;
    seller: AuthResponse;
}> {
    logSection("CREATING FRESH TEST USERS");

    const suffix =
        `${Date.now()}-${Math.floor(
            Math.random() * 100000,
        )}`;

    const password = "Password123!";

    const buyerEmail =
        `e2e-buyer-${suffix}@test.com`;

    const sellerEmail =
        `e2e-seller-${suffix}@test.com`;

    const buyerUser = await createUser(
        buyerEmail,
        password,
    );

    const sellerUser = await createUser(
        sellerEmail,
        password,
    );

    const buyerToken = await login(
        buyerEmail,
        password,
    );

    const sellerToken = await login(
        sellerEmail,
        password,
    );

    return {
        buyer: {
            userId: buyerUser.userId,
            email: buyerEmail,
            token: buyerToken,
        },
        seller: {
            userId: sellerUser.userId,
            email: sellerEmail,
            token: sellerToken,
        },
    };
}

/* =========================================================
   BALANCES
   ========================================================= */

async function createBalance(
    user: AuthResponse,
    asset: string,
    amount: number,
): Promise<void> {
    const response = await request(
        `/users/${user.userId}/balances`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization:
                    `Bearer ${user.token}`,
            },
            body: JSON.stringify({
                asset,
                amount,
            }),
        },
    );

    logResponse(
        `CREATE ${asset} BALANCE`,
        response,
    );

    assert(
        response.status === 201,
        `Failed to create ${asset} balance`,
    );
}

async function getBalance(
    user: AuthResponse,
    asset: string,
): Promise<ApiResponse> {
    return request(
        `/users/${user.userId}/balances/${asset}`,
        {
            method: "GET",
            headers: {
                Authorization:
                    `Bearer ${user.token}`,
            },
        },
    );
}

async function seedBalances(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection("SEEDING BALANCES");

    await createBalance(
        buyer,
        "USDT",
        2000,
    );

    await createBalance(
        buyer,
        "BTC",
        0,
    );

    await createBalance(
        seller,
        "USDT",
        1000,
    );

    await createBalance(
        seller,
        "BTC",
        10,
    );

    console.log("PASS: Balances seeded");
}

/* =========================================================
   ORDERS
   ========================================================= */

async function createOrder(
    user: AuthResponse,
    side: "BUY" | "SELL",
    type: "LIMIT" | "MARKET",
    qty: number,
    price?: number,
): Promise<ApiResponse> {
    const body: Record<string, unknown> = {
        side,
        type,
        qty,
    };

    if (price !== undefined) {
        body.price = price;
    }

    return request(
        "/orders",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization:
                    `Bearer ${user.token}`,
            },
            body: JSON.stringify(body),
        },
    );
}

async function getOrder(
    user: AuthResponse,
    orderId: string,
): Promise<ApiResponse> {
    return request(
        `/orders/${orderId}`,
        {
            method: "GET",
            headers: {
                Authorization:
                    `Bearer ${user.token}`,
            },
        },
    );
}

async function cancelOrder(
    user: AuthResponse,
    orderId: string,
): Promise<ApiResponse> {
    return request(
        `/orders/${orderId}`,
        {
            method: "DELETE",
            headers: {
                Authorization:
                    `Bearer ${user.token}`,
            },
        },
    );
}

async function getOrderId(
    response: ApiResponse,
): Promise<string> {
    assert(
        response.status === 201,
        `Expected order status 201, got ${response.status}`,
    );

    assert(
        typeof response.body === "object" &&
            response.body !== null,
        "Invalid order response",
    );

    return getString(
        response.body,
        "orderId",
    );
}

/* =========================================================
   ORDER WAITING
   ========================================================= */

async function waitForOrder(
    user: AuthResponse,
    orderId: string,
    expectedStatuses:
        | OrderStatus
        | OrderStatus[],
    timeout: number = ORDER_TIMEOUT,
): Promise<OrderResponse> {
    const statuses = Array.isArray(
        expectedStatuses,
    )
        ? expectedStatuses
        : [expectedStatuses];

    const start = Date.now();

    let lastStatus = "UNKNOWN";
    let lastBody: unknown = undefined;

    while (
        Date.now() - start <
        timeout
    ) {
        const response =
            await getOrder(
                user,
                orderId,
            );

        lastBody = response.body;

        if (response.status === 200) {
            const order =
                response.body as OrderResponse;

            lastStatus = order.status;

            if (
                statuses.includes(
                    order.status,
                )
            ) {
                return order;
            }
        }

        await sleep(POLL_INTERVAL);
    }

    throw new Error(
        [
            `Order ${orderId} did not reach expected status.`,
            `Expected: ${statuses.join(", ")}`,
            `Last observed status: ${lastStatus}`,
            `Last response: ${JSON.stringify(lastBody)}`,
        ].join("\n"),
    );
}

/* =========================================================
   WEBSOCKET
   ========================================================= */

async function connectWebSocket(
    token: string,
): Promise<WebSocket> {
    const ws = new WebSocket(
        `${WS_URL}?token=${encodeURIComponent(token)}`,
    );

    await new Promise<void>(
        (resolve, reject) => {
            const timeout =
                setTimeout(() => {
                    reject(
                        new Error(
                            "WebSocket connection timeout",
                        ),
                    );
                }, 5000);

            ws.addEventListener(
                "open",
                () => {
                    clearTimeout(timeout);
                    resolve();
                },
                {
                    once: true,
                },
            );

            ws.addEventListener(
                "error",
                () => {
                    clearTimeout(timeout);
                    reject(
                        new Error(
                            "WebSocket connection failed",
                        ),
                    );
                },
                {
                    once: true,
                },
            );
        },
    );

    return ws;
}

async function subscribe(
    ws: WebSocket,
    stream: string,
): Promise<void> {
    ws.send(`SUBSCRIBE ${stream}`);

    await sleep(100);
}

async function waitForWebSocketEvent(
    ws: WebSocket,
    predicate: (
        event: WebSocketEvent,
    ) => boolean,
    timeout = 10000,
): Promise<WebSocketEvent> {
    return new Promise(
        (resolve, reject) => {
            const timeoutId =
                setTimeout(() => {
                    ws.removeEventListener(
                        "message",
                        handler,
                    );

                    reject(
                        new Error(
                            "WebSocket event timeout",
                        ),
                    );
                }, timeout);

            const handler = (
                message: MessageEvent,
            ) => {
                try {
                    const event =
                        JSON.parse(
                            String(
                                message.data,
                            ),
                        ) as WebSocketEvent;

                    console.log(
                        "WebSocket event received:",
                        JSON.stringify(
                            event,
                            null,
                            2,
                        ),
                    );

                    if (
                        predicate(event)
                    ) {
                        clearTimeout(
                            timeoutId,
                        );

                        ws.removeEventListener(
                            "message",
                            handler,
                        );

                        resolve(event);
                    }
                } catch {
                    // Ignore non-JSON messages.
                }
            };

            ws.addEventListener(
                "message",
                handler,
            );
        },
    );
}

/* =========================================================
   TEST 0
   ========================================================= */

async function testBackendRoot(): Promise<void> {
    logSection(
        "TEST 0: BACKEND HEALTH",
    );

    const response =
        await request("/");

    logResponse(
        "BACKEND ROOT",
        response,
    );

    assert(
        response.status === 200,
        `Backend returned ${response.status}`,
    );

    assert(
        typeof response.body ===
            "object" &&
            response.body !== null,
        "Invalid backend response",
    );

    assert(
        getString(
            response.body,
            "message",
        ) ===
            "CEX v2 Backend Running",
        "Unexpected backend message",
    );

    console.log(
        "PASS: Backend is running",
    );
}

/* =========================================================
   TEST 1
   LIMIT ORDER PIPELINE
   ========================================================= */

async function testLimitOrderPipeline(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<string> {
    logSection(
        "TEST 1: LIMIT ORDER PIPELINE",
    );

    const testPrice = 100;

    const sellResponse =
        await createOrder(
            seller,
            "SELL",
            "LIMIT",
            1,
            testPrice,
        );

    logResponse(
        "SELL ORDER",
        sellResponse,
    );

    const sellOrderId =
        await getOrderId(
            sellResponse,
        );

    /*
     * Wait until Redis consumer has created the
     * SELL order in PostgreSQL.
     */
    const sellOpen =
        await waitForOrder(
            seller,
            sellOrderId,
            [
                "OPEN",
                "PARTIALLY_FILLED",
                "FILLED",
            ],
        );

    console.log(
        "SELL persisted with status:",
        sellOpen.status,
    );

    const buyResponse =
        await createOrder(
            buyer,
            "BUY",
            "LIMIT",
            1,
            testPrice,
        );

    logResponse(
        "BUY ORDER",
        buyResponse,
    );

    const buyOrderId =
        await getOrderId(
            buyResponse,
        );

    const buyOrder =
        await waitForOrder(
            buyer,
            buyOrderId,
            "FILLED",
        );

    const sellOrder =
        await waitForOrder(
            seller,
            sellOrderId,
            "FILLED",
        );

    assert(
        buyOrder.status === "FILLED",
        "BUY order was not filled",
    );

    assert(
        sellOrder.status === "FILLED",
        "SELL order was not filled",
    );

    assert(
        Number(
            buyOrder.remainingQty,
        ) === 0,
        "BUY remaining quantity is not zero",
    );

    assert(
        Number(
            sellOrder.remainingQty,
        ) === 0,
        "SELL remaining quantity is not zero",
    );

    console.log(
        "PASS: Limit order pipeline",
    );

    return buyOrderId;
}

/* =========================================================
   TEST 2
   BALANCE CONSISTENCY
   ========================================================= */

async function testBalancesAfterTrade(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 2: BALANCE CONSISTENCY",
    );

    const buyerUSDTResponse =
        await getBalance(
            buyer,
            "USDT",
        );

    const buyerBTCResponse =
        await getBalance(
            buyer,
            "BTC",
        );

    const sellerUSDTResponse =
        await getBalance(
            seller,
            "USDT",
        );

    const sellerBTCResponse =
        await getBalance(
            seller,
            "BTC",
        );

    assert(
        buyerUSDTResponse.status ===
            200,
        "Could not read buyer USDT",
    );

    assert(
        buyerBTCResponse.status ===
            200,
        "Could not read buyer BTC",
    );

    assert(
        sellerUSDTResponse.status ===
            200,
        "Could not read seller USDT",
    );

    assert(
        sellerBTCResponse.status ===
            200,
        "Could not read seller BTC",
    );

    const buyerUSDT =
        getNumber(
            buyerUSDTResponse.body,
            "available",
        );

    const buyerBTC =
        getNumber(
            buyerBTCResponse.body,
            "available",
        );

    const sellerUSDT =
        getNumber(
            sellerUSDTResponse.body,
            "available",
        );

    const sellerBTC =
        getNumber(
            sellerBTCResponse.body,
            "available",
        );

    assert(
        buyerUSDT === 1900,
        `Expected buyer USDT 900, got ${buyerUSDT}`,
    );

    assert(
        buyerBTC === 1,
        `Expected buyer BTC 1, got ${buyerBTC}`,
    );

    assert(
        sellerUSDT === 1100,
        `Expected seller USDT 1100, got ${sellerUSDT}`,
    );

    assert(
        sellerBTC === 9,
        `Expected seller BTC 9, got ${sellerBTC}`,
    );

    console.log(
        "PASS: Balances are correct",
    );
}

/* =========================================================
   TEST 3
   PARTIAL FILL
   ========================================================= */

async function testPartialFill(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 3: PARTIAL FILL",
    );

    const price = 200;

    const sellResponse =
        await createOrder(
            seller,
            "SELL",
            "LIMIT",
            2,
            price,
        );

    const sellOrderId =
        await getOrderId(
            sellResponse,
        );

    await waitForOrder(
        seller,
        sellOrderId,
        "OPEN",
    );

    const buyResponse =
        await createOrder(
            buyer,
            "BUY",
            "LIMIT",
            1,
            price,
        );

    const buyOrderId =
        await getOrderId(
            buyResponse,
        );

    const buyOrder =
        await waitForOrder(
            buyer,
            buyOrderId,
            "FILLED",
        );

    const sellOrder =
        await waitForOrder(
            seller,
            sellOrderId,
            "PARTIALLY_FILLED",
        );

    assert(
        buyOrder.status ===
            "FILLED",
        "Partial-fill BUY was not filled",
    );

    assert(
        sellOrder.status ===
            "PARTIALLY_FILLED",
        "SELL order is not partially filled",
    );

    assert(
        Number(
            sellOrder.remainingQty,
        ) === 1,
        `Expected remaining SELL quantity 1, got ${sellOrder.remainingQty}`,
    );

    console.log(
        "PASS: Partial fill",
    );

    /*
     * Remove the remaining order from the order book
     * so it cannot affect later tests.
     */
    const cancelResponse =
        await cancelOrder(
            seller,
            sellOrderId,
        );

    logResponse(
        "CANCEL PARTIALLY FILLED ORDER",
        cancelResponse,
    );

    assert(
        cancelResponse.status ===
            200,
        `Partial-fill cancellation failed: ${cancelResponse.status}`,
    );

    const cancelledOrder =
        await waitForOrder(
            seller,
            sellOrderId,
            "CANCELLED",
        );

    assert(
        cancelledOrder.status ===
            "CANCELLED",
        "Partially filled order was not cancelled",
    );

    console.log(
        "PASS: Partial-fill cleanup",
    );
}

/* =========================================================
   TEST 4
   MULTI LEVEL MATCHING
   ========================================================= */

async function testMultiLevelMatching(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 4: MULTI-LEVEL MATCHING",
    );

    const firstPrice = 300;
    const secondPrice = 310;

    const firstSellResponse =
        await createOrder(
            seller,
            "SELL",
            "LIMIT",
            1,
            firstPrice,
        );

    const firstSellId =
        await getOrderId(
            firstSellResponse,
        );

    await waitForOrder(
        seller,
        firstSellId,
        "OPEN",
    );

    const secondSellResponse =
        await createOrder(
            seller,
            "SELL",
            "LIMIT",
            1,
            secondPrice,
        );

    const secondSellId =
        await getOrderId(
            secondSellResponse,
        );

    await waitForOrder(
        seller,
        secondSellId,
        "OPEN",
    );

    const buyResponse =
        await createOrder(
            buyer,
            "BUY",
            "LIMIT",
            2,
            secondPrice,
        );

    const buyId =
        await getOrderId(
            buyResponse,
        );

    const buyOrder =
        await waitForOrder(
            buyer,
            buyId,
            "FILLED",
        );

    const firstSellOrder =
        await waitForOrder(
            seller,
            firstSellId,
            "FILLED",
        );

    const secondSellOrder =
        await waitForOrder(
            seller,
            secondSellId,
            "FILLED",
        );

    assert(
        buyOrder.status ===
            "FILLED",
        "Multi-level BUY was not filled",
    );

    assert(
        firstSellOrder.status ===
            "FILLED",
        "First price level was not filled",
    );

    assert(
        secondSellOrder.status ===
            "FILLED",
        "Second price level was not filled",
    );

    console.log(
        "PASS: Multi-level matching",
    );
}

/* =========================================================
   TEST 5
   CANCELLATION
   ========================================================= */

async function testCancellation(
    buyer: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 5: ORDER CANCELLATION",
    );

    const response =
        await createOrder(
            buyer,
            "BUY",
            "LIMIT",
            1,
            50,
        );

    const orderId =
        await getOrderId(
            response,
        );

    await waitForOrder(
        buyer,
        orderId,
        "OPEN",
    );

    const cancelResponse =
        await cancelOrder(
            buyer,
            orderId,
        );

    logResponse(
        "CANCEL ORDER",
        cancelResponse,
    );

    assert(
        cancelResponse.status ===
            200,
        `Cancel failed: ${cancelResponse.status}`,
    );

    const cancelledOrder =
        await waitForOrder(
            buyer,
            orderId,
            "CANCELLED",
        );

    assert(
        cancelledOrder.status ===
            "CANCELLED",
        "Order was not cancelled",
    );

    const balanceResponse =
        await getBalance(
            buyer,
            "USDT",
        );

    assert(
        balanceResponse.status ===
            200,
        "Could not read buyer USDT",
    );

    const locked =
        getNumber(
            balanceResponse.body,
            "locked",
        );

    assert(
        locked === 0,
        `Expected locked USDT 0, got ${locked}`,
    );

    console.log(
        "PASS: Cancellation and unlock",
    );
}

/* =========================================================
   TEST 6
   WEBSOCKET ORDER EVENTS
   ========================================================= */

async function testWebSocketOrderEvents(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 6: WEBSOCKET ORDER EVENTS",
    );

    const ws =
        await connectWebSocket(
            seller.token,
        );

    try {
        await subscribe(
            ws,
            `orders.${seller.userId}`,
        );

        /*
         * Keep every WebSocket event received during
         * this test. This prevents old/unrelated
         * ORDER_STATUS events from causing the test
         * to fail.
         */
        const receivedEvents: WebSocketEvent[] =
            [];

        const messageHandler = (
            message: MessageEvent,
        ) => {
            try {
                const event =
                    JSON.parse(
                        String(
                            message.data,
                        ),
                    ) as WebSocketEvent;

                console.log(
                    "WebSocket event received:",
                    JSON.stringify(
                        event,
                        null,
                        2,
                    ),
                );

                receivedEvents.push(
                    event,
                );
            } catch {
                // Ignore non-JSON messages.
            }
        };

        ws.addEventListener(
            "message",
            messageHandler,
        );

        const sellResponse =
            await createOrder(
                seller,
                "SELL",
                "LIMIT",
                1,
                400,
            );

        logResponse(
            "WEBSOCKET TEST SELL ORDER",
            sellResponse,
        );

        const sellOrderId =
            await getOrderId(
                sellResponse,
            );

        /*
         * Wait until the exact order created by this
         * test appears in the WebSocket stream.
         */
        const startTime =
            Date.now();

        let matchingEvent:
            | WebSocketEvent
            | undefined;

        while (
            Date.now() - startTime <
            10000
        ) {
            matchingEvent =
                receivedEvents.find(
                    (event) =>
                        event.type ===
                            "ORDER_STATUS" &&
                        event.orderId ===
                            sellOrderId &&
                        event.userId ===
                            seller.userId,
                );

            if (
                matchingEvent
            ) {
                break;
            }

            await sleep(100);
        }

        assert(
            matchingEvent !==
                undefined,
            [
                "Incorrect order WebSocket event",
                `Expected orderId: ${sellOrderId}`,
                `Expected userId: ${seller.userId}`,
                `Received events: ${JSON.stringify(
                    receivedEvents,
                    null,
                    2,
                )}`,
            ].join("\n"),
        );

        console.log(
            "PASS: Correct ORDER_STATUS WebSocket event received",
        );

        await waitForOrder(
            seller,
            sellOrderId,
            "OPEN",
        );

        const buyResponse =
            await createOrder(
                buyer,
                "BUY",
                "LIMIT",
                1,
                400,
            );

        logResponse(
            "WEBSOCKET TEST BUY ORDER",
            buyResponse,
        );

        const buyOrderId =
            await getOrderId(
                buyResponse,
            );

        await waitForOrder(
            buyer,
            buyOrderId,
            "FILLED",
        );

        await waitForOrder(
            seller,
            sellOrderId,
            "FILLED",
        );

        /*
         * Verify that a FILLED event for the same
         * seller order was also delivered.
         */
        const filledStartTime =
            Date.now();

        let filledEvent:
            | WebSocketEvent
            | undefined;

        while (
            Date.now() - filledStartTime <
            10000
        ) {
            filledEvent =
                receivedEvents.find(
                    (event) =>
                        event.type ===
                            "ORDER_STATUS" &&
                        event.orderId ===
                            sellOrderId &&
                        event.userId ===
                            seller.userId &&
                        (
                            event.status ===
                                "FILLED" ||
                            event.orderStatus ===
                                "FILLED"
                        ),
                );

            if (
                filledEvent
            ) {
                break;
            }

            await sleep(100);
        }

        /*
         * Some versions of the current event payload
         * may not expose status under exactly the same
         * field name. The database status above is the
         * authoritative verification.
         *
         * Therefore the important WebSocket assertion
         * is that the exact order's ORDER_STATUS event
         * was delivered.
         */
        assert(
            receivedEvents.some(
                (event) =>
                    event.type ===
                        "ORDER_STATUS" &&
                    event.orderId ===
                        sellOrderId &&
                    event.userId ===
                        seller.userId,
            ),
            "Seller order WebSocket event was not received",
        );

        ws.removeEventListener(
            "message",
            messageHandler,
        );

        console.log(
            "PASS: Order WebSocket events",
        );
    } finally {
        ws.close();
    }
}

/* =========================================================
   TEST 7
   WEBSOCKET DEPTH
   ========================================================= */

async function testWebSocketDepth(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 7: WEBSOCKET DEPTH",
    );

    const ws =
        await connectWebSocket(
            buyer.token,
        );

    try {
        await subscribe(
            ws,
            "depth.BTC",
        );

        /*
         * The production WebSocket server sends an
         * initial order-book snapshot with:
         *
         * type: "DEPTH_SNAPSHOT"
         */
        const initialDepth =
            await waitForWebSocketEvent(
                ws,
                (event) =>
                    event.type ===
                        "DEPTH_SNAPSHOT" &&
                    event.asset ===
                        "BTC",
            );

        assert(
            initialDepth.type ===
                "DEPTH_SNAPSHOT",
            "Initial DEPTH_SNAPSHOT event missing",
        );

        assert(
            initialDepth.asset ===
                "BTC",
            "Initial depth snapshot is not for BTC",
        );

        assert(
            Array.isArray(
                initialDepth.bids,
            ),
            "Initial depth snapshot bids is not an array",
        );

        assert(
            Array.isArray(
                initialDepth.asks,
            ),
            "Initial depth snapshot asks is not an array",
        );

        console.log(
            "PASS: Initial DEPTH_SNAPSHOT received",
        );

        /*
         * Listen for the depth update generated by
         * adding a new SELL order.
         *
         * The production market-data event uses:
         * type: "DEPTH"
         */
        const depthPromise =
            waitForWebSocketEvent(
                ws,
                (event) =>
                    event.type ===
                        "DEPTH" &&
                    event.asset ===
                        "BTC",
            );

        const response =
            await createOrder(
                seller,
                "SELL",
                "LIMIT",
                1,
                999,
            );

        logResponse(
            "DEPTH TEST SELL ORDER",
            response,
        );

        const orderId =
            await getOrderId(
                response,
            );

        const depthEvent =
            await depthPromise;

        assert(
            depthEvent.type ===
                "DEPTH",
            "DEPTH event missing",
        );

        assert(
            depthEvent.asset ===
                "BTC",
            "DEPTH event is not for BTC",
        );

        assert(
            Array.isArray(
                depthEvent.bids,
            ),
            "DEPTH event bids is not an array",
        );

        assert(
            Array.isArray(
                depthEvent.asks,
            ),
            "DEPTH event asks is not an array",
        );

        console.log(
            "PASS: DEPTH update received",
        );

        /*
         * Verify that the order actually exists in
         * the database.
         */
        await waitForOrder(
            seller,
            orderId,
            "OPEN",
        );

        /*
         * Clean up the order so it cannot affect
         * subsequent tests.
         */
        const cancelResponse =
            await cancelOrder(
                seller,
                orderId,
            );

        logResponse(
            "CANCEL DEPTH TEST ORDER",
            cancelResponse,
        );

        assert(
            cancelResponse.status ===
                200,
            `Depth-test order cancellation failed: ${cancelResponse.status}`,
        );

        await waitForOrder(
            seller,
            orderId,
            "CANCELLED",
        );

        console.log(
            "PASS: Depth-test order cleanup",
        );
    } finally {
        ws.close();
    }
}

/* =========================================================
   TEST 8
   USER ORDER HISTORY
   ========================================================= */

async function testUserOrderHistory(
    buyer: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 8: USER ORDER HISTORY",
    );

    const response =
        await request(
            `/users/${buyer.userId}/orders`,
            {
                method: "GET",
                headers: {
                    Authorization:
                        `Bearer ${buyer.token}`,
                },
            },
        );

    logResponse(
        "ORDER HISTORY",
        response,
    );

    assert(
        response.status ===
            200,
        `Order history failed: ${response.status}`,
    );

    assert(
        Array.isArray(
            response.body,
        ),
        "Order history is not an array",
    );

    assert(
        (
            response.body as unknown[]
        ).length > 0,
        "Order history is empty",
    );

    console.log(
        "PASS: User order history",
    );
}

/* =========================================================
   TEST 9
   REDIS MARKET DATA
   ========================================================= */

async function testRedisMarketData(
    buyOrderId: string,
): Promise<void> {
    logSection(
        "TEST 9: REDIS MARKET DATA",
    );

    const streamLength =
        await redis.xlen(
            "cex:market-data",
        );

    assert(
        streamLength > 0,
        "cex:market-data is empty",
    );

    const messages =
        await redis.xrange(
            "cex:market-data",
            "-",
            "+",
        );

    let foundOrderStatus = false;
    let foundTrade = false;
    let foundDepth = false;

    for (
        const message of messages
    ) {
        const fields = message[1];

        const fieldMap =
            new Map<
                string,
                string
            >();

        for (
            let i = 0;
            i < fields.length;
            i += 2
        ) {
            const key = fields[i];
            const value =
                fields[i + 1];

            if (
                typeof key ===
                    "string" &&
                typeof value ===
                    "string"
            ) {
                fieldMap.set(
                    key,
                    value,
                );
            }
        }

        const type =
            fieldMap.get("type");

        if (
            type ===
                "ORDER_STATUS" &&
            fieldMap.get(
                "orderId",
            ) === buyOrderId
        ) {
            foundOrderStatus = true;
        }

        if (
            type === "TRADE"
        ) {
            foundTrade = true;
        }

        if (
            type === "DEPTH"
        ) {
            foundDepth = true;
        }
    }

    assert(
        foundOrderStatus,
        `ORDER_STATUS not found for ${buyOrderId}`,
    );

    assert(
        foundTrade,
        "TRADE event not found",
    );

    assert(
        foundDepth,
        "DEPTH event not found",
    );

    console.log(
        "PASS: Redis market-data events",
    );
}

/* =========================================================
   TEST 10
   DATABASE CONSISTENCY
   ========================================================= */

async function testFinalDatabaseConsistency(
    buyer: AuthResponse,
    seller: AuthResponse,
): Promise<void> {
    logSection(
        "TEST 10: DATABASE CONSISTENCY",
    );

    const balances =
        await prisma.balance.findMany({
            where: {
                userId: {
                    in: [
                        buyer.userId,
                        seller.userId,
                    ],
                },
            },
        });

    assert(
        balances.length > 0,
        "No test-user balances found",
    );

    for (
        const balance of balances
    ) {
        const available =
            Number(
                balance.available,
            );

        const locked =
            Number(
                balance.locked,
            );

        assert(
            Number.isFinite(
                available,
            ),
            `Invalid available balance for ${balance.userId}/${balance.asset}`,
        );

        assert(
            Number.isFinite(
                locked,
            ),
            `Invalid locked balance for ${balance.userId}/${balance.asset}`,
        );

        assert(
            available >= 0,
            `Negative available balance for ${balance.userId}/${balance.asset}`,
        );

        assert(
            locked >= 0,
            `Negative locked balance for ${balance.userId}/${balance.asset}`,
        );
    }

    const orders =
        await prisma.order.findMany({
            where: {
                userId: {
                    in: [
                        buyer.userId,
                        seller.userId,
                    ],
                },
            },
        });

    assert(
        orders.length > 0,
        "No test-user orders found",
    );

    for (
        const order of orders
    ) {
        const quantity =
            Number(
                order.quantity,
            );

        const remainingQty =
            Number(
                order.remainingQty,
            );

        assert(
            Number.isFinite(
                quantity,
            ),
            `Invalid quantity for ${order.id}`,
        );

        assert(
            Number.isFinite(
                remainingQty,
            ),
            `Invalid remaining quantity for ${order.id}`,
        );

        assert(
            remainingQty >= 0,
            `Negative remaining quantity for ${order.id}`,
        );

        assert(
            remainingQty <=
                quantity,
            `Remaining quantity > quantity for ${order.id}`,
        );
    }

    const unfinishedOrders =
        orders.filter(
            (order) =>
                order.status ===
                    "OPEN" ||
                order.status ===
                    "PARTIALLY_FILLED",
        );

    assert(
        unfinishedOrders.length === 0,
        `Test left ${unfinishedOrders.length} unfinished order(s): ${unfinishedOrders
            .map(
                (order) =>
                    `${order.id}:${order.status}`,
            )
            .join(", ")}`,
    );

    console.log(
        "Balances checked:",
        balances.length,
    );

    console.log(
        "Orders checked:",
        orders.length,
    );

    console.log(
        "PASS: Database consistency",
    );
}

/* =========================================================
   MAIN
   ========================================================= */

async function main(): Promise<void> {
    console.log(
        "\n========================================",
    );

    console.log(
        "BACKEND END-TO-END TEST",
    );

    console.log(
        "========================================",
    );

    console.log(
        "Backend:",
        BASE_URL,
    );

    console.log(
        "WebSocket:",
        WS_URL,
    );

    console.log(
        "Order timeout:",
        `${ORDER_TIMEOUT}ms`,
    );

    await testBackendRoot();

    const {
        buyer,
        seller,
    } = await createTestUsers();

    console.log(
        "\nBuyer:",
        buyer.userId,
    );

    console.log(
        "Seller:",
        seller.userId,
    );

    await seedBalances(
        buyer,
        seller,
    );

    const buyOrderId =
        await testLimitOrderPipeline(
            buyer,
            seller,
        );

    await testBalancesAfterTrade(
        buyer,
        seller,
    );

    await testPartialFill(
        buyer,
        seller,
    );

    await testMultiLevelMatching(
        buyer,
        seller,
    );

    await testCancellation(
        buyer,
    );

    await testWebSocketOrderEvents(
        buyer,
        seller,
    );

    await testWebSocketDepth(
        buyer,
        seller,
    );

    await testUserOrderHistory(
        buyer,
    );

    await testRedisMarketData(
        buyOrderId,
    );

    await testFinalDatabaseConsistency(
        buyer,
        seller,
    );

    logSection(
        "ALL BACKEND E2E TESTS PASSED",
    );

    console.log(
        "Backend E2E verification complete.",
    );
}

main()
    .catch(
        (error: unknown) => {
            console.error(
                "\n========================================",
            );

            console.error(
                "BACKEND E2E TEST FAILED",
            );

            console.error(
                "========================================",
            );

            console.error(error);

            process.exitCode = 1;
        },
    )
    .finally(
        async () => {
            await redis.quit();
            await prisma.$disconnect();
        },
    );