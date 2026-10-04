import assert from "node:assert";

import { prisma } from "../apps/engine/db";

import { redis } from "../apps/engine/redis";



const BASE_URL = "http://localhost:3000";

const WS_URL = "ws://localhost:3001";



type ApiResponse = {

    status: number;

    body: unknown;

};



type AuthResponse = {

    token: string;

    userId: string;

    email: string;

};



type OrderResponse = {

    id: string;

    userId: string;

    side: "BUY" | "SELL";

    type: "LIMIT" | "MARKET";

    asset: string;

    quantity: number | string;

    remainingQty: number | string;

    price: number | string | null;

    status:

        | "OPEN"

        | "PARTIALLY_FILLED"

        | "FILLED"

        | "CANCELLED";

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

    if (

        typeof value !== "object" ||

        value === null ||

        !(field in value)

    ) {

        throw new Error(

            `Field "${field}" not found`,

        );

    }



    const fieldValue =

        (value as Record<string, unknown>)[

            field

        ];



    if (typeof fieldValue !== "string") {

        throw new Error(

            `Field "${field}" is not a string`,

        );

    }



    return fieldValue;

}



function getNumber(

    value: unknown,

    field: string,

): number {

    if (

        typeof value !== "object" ||

        value === null ||

        !(field in value)

    ) {

        throw new Error(

            `Field "${field}" not found`,

        );

    }



    const fieldValue =

        (value as Record<string, unknown>)[

            field

        ];



    const numberValue = Number(fieldValue);



    if (!Number.isFinite(numberValue)) {

        throw new Error(

            `Field "${field}" is not a valid number`,

        );

    }



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

                "Content-Type":

                    "application/json",

            },

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



    assert(

        typeof response.body ===

            "object" &&

            response.body !== null,

        "User creation response is invalid",

    );



    const userId = getString(

        response.body,

        "id",

    );



    const returnedEmail = getString(

        response.body,

        "email",

    );



    return {

        userId,

        email: returnedEmail,

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

                "Content-Type":

                    "application/json",

            },

            body: JSON.stringify({

                email,

                password,

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



    assert(

        typeof response.body ===

            "object" &&

            response.body !== null,

        "Login response is invalid",

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

    logSection(

        "CREATING TEST USERS",

    );



    const suffix =

        `${Date.now()}-${Math.floor(

            Math.random() * 100000,

        )}`;



    const buyerEmail =

        `e2e-buyer-${suffix}@test.com`;



    const sellerEmail =

        `e2e-seller-${suffix}@test.com`;



    const password =

        "Password123!";



    const buyerUser =

        await createUser(

            buyerEmail,

            password,

        );



    const sellerUser =

        await createUser(

            sellerEmail,

            password,

        );



    const buyerToken =

        await login(

            buyerEmail,

            password,

        );



    const sellerToken =

        await login(

            sellerEmail,

            password,

        );



    return {

        buyer: {

            userId:

                buyerUser.userId,

            email: buyerEmail,

            token: buyerToken,

        },

        seller: {

            userId:

                sellerUser.userId,

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

                "Content-Type":

                    "application/json",

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

    logSection(

        "SEEDING BALANCES THROUGH API",

    );



    await createBalance(

        buyer,

        "USDT",

        1000,

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



    console.log(

        "PASS: Test balances created through API",

    );

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

    const body: Record<

        string,

        unknown

    > = {

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

                "Content-Type":

                    "application/json",

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

        `Expected 201, received ${response.status}`,

    );



    assert(

        typeof response.body ===

            "object" &&

            response.body !== null,

        "Order response is invalid",

    );



    return getString(

        response.body,

        "orderId",

    );

}



async function waitForOrder(

    user: AuthResponse,

    orderId: string,

    expectedStatuses: string[],

    timeoutMs = 10000,

): Promise<OrderResponse> {

    const start = Date.now();



    while (

        Date.now() - start <

        timeoutMs

    ) {

        const response =

            await getOrder(

                user,

                orderId,

            );



        if (response.status === 200) {

            const order =

                response.body as OrderResponse;



            if (

                expectedStatuses.includes(

                    order.status,

                )

            ) {

                return order;

            }

        }



        await sleep(200);

    }



    throw new Error(

        `Order ${orderId} did not reach expected status: ${expectedStatuses.join(

            ", ",

        )}`,

    );

}



/* =========================================================

   WEBSOCKET

   ========================================================= */



async function connectWebSocket(

    token: string,

): Promise<WebSocket> {

    const ws = new WebSocket(

        `${WS_URL}?token=${encodeURIComponent(

            token,

        )}`,

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

                }, 10000);



            ws.onopen = () => {

                clearTimeout(timeout);

                resolve();

            };



            ws.onerror = () => {

                clearTimeout(timeout);

                reject(

                    new Error(

                        "WebSocket connection failed",

                    ),

                );

            };

        },

    );



    return ws;

}



async function subscribe(

    ws: WebSocket,

    channel: string,

): Promise<void> {

    ws.send(

        JSON.stringify({

            action: "subscribe",

            channel,

        }),

    );



    await sleep(100);

}



async function waitForWebSocketEvent(

    ws: WebSocket,

    predicate: (

        event: WebSocketEvent,

    ) => boolean,

    timeoutMs = 10000,

): Promise<WebSocketEvent> {

    return new Promise(

        (resolve, reject) => {

            const timeout =

                setTimeout(() => {

                    ws.onmessage = null;

                    ws.onerror = null;



                    reject(

                        new Error(

                            "Timed out waiting for WebSocket event",

                        ),

                    );

                }, timeoutMs);



            ws.onmessage = (

                message: MessageEvent,

            ) => {

                try {

                    const event =

                        JSON.parse(

                            String(

                                message.data,

                            ),

                        ) as WebSocketEvent;



                    if (

                        predicate(event)

                    ) {

                        clearTimeout(

                            timeout,

                        );



                        ws.onmessage = null;

                        ws.onerror = null;



                        resolve(event);

                    }

                } catch {

                    // Ignore invalid messages.

                }

            };



            ws.onerror = () => {

                clearTimeout(timeout);



                ws.onmessage = null;

                ws.onerror = null;



                reject(

                    new Error(

                        "WebSocket error",

                    ),

                );

            };

        },

    );

}



/* =========================================================

   TEST 0

   ========================================================= */



async function testBackendRoot(): Promise<void> {

    logSection(

        "TEST 0: BACKEND ROOT",

    );



    const response =

        await request("/");



    logResponse(

        "ROOT",

        response,

    );



    assert(

        response.status === 200,

        `Backend root failed with status ${response.status}`,

    );



    assert(

        typeof response.body ===

            "object" &&

            response.body !== null,

        "Root response is invalid",

    );



    console.log(

        "PASS: Backend is running",

    );

}



/* =========================================================

   TEST 1

   ========================================================= */



async function testLimitOrderPipeline(

    buyer: AuthResponse,

    seller: AuthResponse,

): Promise<string> {

    logSection(

        "TEST 1: LIMIT ORDER PIPELINE",

    );



    const sellResponse =

        await createOrder(

            seller,

            "SELL",

            "LIMIT",

            1,

            100,

        );



    logResponse(

        "SELL ORDER",

        sellResponse,

    );



    const sellOrderId =

        await getOrderId(

            sellResponse,

        );



    await waitForOrder(

        seller,

        sellOrderId,

        ["OPEN"],

    );



    const buyResponse =

        await createOrder(

            buyer,

            "BUY",

            "LIMIT",

            1,

            100,

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

            ["FILLED"],

        );



    const sellOrder =

        await waitForOrder(

            seller,

            sellOrderId,

            ["FILLED"],

        );



    assert(

        buyOrder.status ===

            "FILLED",

        "BUY order was not filled",

    );



    assert(

        sellOrder.status ===

            "FILLED",

        "SELL order was not filled",

    );



    console.log(

        "PASS: LIMIT order pipeline",

    );



    return buyOrderId;

}



/* =========================================================

   TEST 2

   ========================================================= */



async function testBalancesAfterTrade(

    buyer: AuthResponse,

    seller: AuthResponse,

): Promise<void> {

    logSection(

        "TEST 2: BALANCES AFTER TRADE",

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



    logResponse(

        "BUYER USDT",

        buyerUSDTResponse,

    );



    logResponse(

        "BUYER BTC",

        buyerBTCResponse,

    );



    logResponse(

        "SELLER USDT",

        sellerUSDTResponse,

    );



    logResponse(

        "SELLER BTC",

        sellerBTCResponse,

    );



    assert(

        buyerUSDTResponse.status ===

            200 &&

            buyerBTCResponse.status ===

                200,

        "Could not read buyer balances",

    );



    assert(

        sellerUSDTResponse.status ===

            200 &&

            sellerBTCResponse.status ===

                200,

        "Could not read seller balances",

    );



    const buyerUSDTAvailable =

        getNumber(

            buyerUSDTResponse.body,

            "available",

        );



    const buyerUSDTLocked =

        getNumber(

            buyerUSDTResponse.body,

            "locked",

        );



    const buyerBTCAvailable =

        getNumber(

            buyerBTCResponse.body,

            "available",

        );



    const buyerBTCLocked =

        getNumber(

            buyerBTCResponse.body,

            "locked",

        );



    const sellerUSDTAvailable =

        getNumber(

            sellerUSDTResponse.body,

            "available",

        );



    const sellerUSDTLocked =

        getNumber(

            sellerUSDTResponse.body,

            "locked",

        );



    const sellerBTCAvailable =

        getNumber(

            sellerBTCResponse.body,

            "available",

        );



    const sellerBTCLocked =

        getNumber(

            sellerBTCResponse.body,

            "locked",

        );



    assert(

        buyerUSDTAvailable === 900,

        `Expected buyer USDT 900, got ${buyerUSDTAvailable}`,

    );



    assert(

        buyerUSDTLocked === 0,

        `Expected buyer USDT locked 0, got ${buyerUSDTLocked}`,

    );



    assert(

        buyerBTCAvailable === 1,

        `Expected buyer BTC 1, got ${buyerBTCAvailable}`,

    );



    assert(

        buyerBTCLocked === 0,

        `Expected buyer BTC locked 0, got ${buyerBTCLocked}`,

    );



    assert(

        sellerUSDTAvailable === 1100,

        `Expected seller USDT 1100, got ${sellerUSDTAvailable}`,

    );



    assert(

        sellerUSDTLocked === 0,

        `Expected seller USDT locked 0, got ${sellerUSDTLocked}`,

    );



    assert(

        sellerBTCAvailable === 9,

        `Expected seller BTC 9, got ${sellerBTCAvailable}`,

    );



    assert(

        sellerBTCLocked === 0,

        `Expected seller BTC locked 0, got ${sellerBTCLocked}`,

    );



    console.log(

        "PASS: Balances are correct",

    );

}



/* =========================================================

   TEST 3

   ========================================================= */



async function testPartialFill(

    buyer: AuthResponse,

    seller: AuthResponse,

): Promise<void> {

    logSection(

        "TEST 3: PARTIAL FILL",

    );



    const sellResponse =

        await createOrder(

            seller,

            "SELL",

            "LIMIT",

            2,

            100,

        );



    const sellOrderId =

        await getOrderId(

            sellResponse,

        );



    await waitForOrder(

        seller,

        sellOrderId,

        ["OPEN"],

    );



    const buyResponse =

        await createOrder(

            buyer,

            "BUY",

            "LIMIT",

            1,

            100,

        );



    const buyOrderId =

        await getOrderId(

            buyResponse,

        );



    await waitForOrder(

        buyer,

        buyOrderId,

        ["FILLED"],

    );



    const sellOrder =

        await waitForOrder(

            seller,

            sellOrderId,

            ["PARTIALLY_FILLED"],

        );



    assert(

        sellOrder.status ===

            "PARTIALLY_FILLED",

        "SELL order was not partially filled",

    );



    assert(

        Number(

            sellOrder.remainingQty,

        ) === 1,

        `Expected remaining quantity 1, got ${sellOrder.remainingQty}`,

    );



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

        cancelResponse.status === 200,

        `Partial-fill order cancellation failed with status ${cancelResponse.status}`,

    );



    const cancelledSellOrder =

        await waitForOrder(

            seller,

            sellOrderId,

            ["CANCELLED"],

        );



    assert(

        cancelledSellOrder.status === "CANCELLED",

        "Partially filled SELL order was not cancelled",

    );



    console.log(

        "PASS: Partial fill and cleanup",

    );

}



/* =========================================================

   TEST 4

   ========================================================= */



async function testMultiLevelMatching(

    buyer: AuthResponse,

    seller: AuthResponse,

): Promise<void> {

    logSection(

        "TEST 4: MULTI-LEVEL MATCHING",

    );



    const firstSell =

        await createOrder(

            seller,

            "SELL",

            "LIMIT",

            1,

            105,

        );



    const firstSellId =

        await getOrderId(

            firstSell,

        );



    await waitForOrder(

        seller,

        firstSellId,

        ["OPEN"],

    );



    const secondSell =

        await createOrder(

            seller,

            "SELL",

            "LIMIT",

            1,

            110,

        );



    const secondSellId =

        await getOrderId(

            secondSell,

        );



    await waitForOrder(

        seller,

        secondSellId,

        ["OPEN"],

    );



    const buy =

        await createOrder(

            buyer,

            "BUY",

            "LIMIT",

            2,

            110,

        );



    const buyId =

        await getOrderId(buy);



    const buyOrder =

        await waitForOrder(

            buyer,

            buyId,

            ["FILLED"],

        );



    const firstSellOrder =

        await waitForOrder(

            seller,

            firstSellId,

            ["FILLED"],

        );



    const secondSellOrder =

        await waitForOrder(

            seller,

            secondSellId,

            ["FILLED"],

        );



    assert(

        buyOrder.status ===

            "FILLED",

        "Multi-level BUY not filled",

    );



    assert(

        firstSellOrder.status ===

            "FILLED",

        "First level not filled",

    );



    assert(

        secondSellOrder.status ===

            "FILLED",

        "Second level not filled",

    );



    console.log(

        "PASS: Multi-level matching",

    );

}



/* =========================================================

   TEST 5

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

        await getOrderId(response);



    await waitForOrder(

        buyer,

        orderId,

        ["OPEN"],

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

        `Cancel failed with status ${cancelResponse.status}`,

    );



    const cancelledOrder =

        await waitForOrder(

            buyer,

            orderId,

            ["CANCELLED"],

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

        "Could not read balance",

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



        const eventPromise =

            waitForWebSocketEvent(

                ws,

                (event) =>

                    event.type ===

                        "ORDER_STATUS" &&

                    typeof event.orderId ===

                        "string",

            );



        const response =

            await createOrder(

                seller,

                "SELL",

                "LIMIT",

                1,

                120,

            );



        const sellOrderId =

            await getOrderId(

                response,

            );



        const event =

            await eventPromise;



        assert(

            event.orderId ===

                sellOrderId,

            "Incorrect order WebSocket event",

        );



        await waitForOrder(

            seller,

            sellOrderId,

            ["OPEN"],

        );



        const buyResponse =

            await createOrder(

                buyer,

                "BUY",

                "LIMIT",

                1,

                120,

            );



        const buyOrderId =

            await getOrderId(

                buyResponse,

            );



        await waitForOrder(

            buyer,

            buyOrderId,

            ["FILLED"],

        );



        await waitForOrder(

            seller,

            sellOrderId,

            ["FILLED"],

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



        const initialDepth =

            await waitForWebSocketEvent(

                ws,

                (event) =>

                    event.type ===

                    "DEPTH",

            );



        assert(

            initialDepth.type ===

                "DEPTH",

            "Initial DEPTH event missing",

        );



        const depthPromise =

            waitForWebSocketEvent(

                ws,

                (event) =>

                    event.type ===

                    "DEPTH",

            );



        const response =

            await createOrder(

                seller,

                "SELL",

                "LIMIT",

                1,

                999,

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



        await waitForOrder(

            seller,

            orderId,

            ["OPEN"],

        );



        console.log(

            "PASS: Depth WebSocket events",

        );

    } finally {

        ws.close();

    }

}



/* =========================================================

   TEST 8

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

        `Order history failed with status ${response.status}`,

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



    for (const message of messages) {

        const fields =

            message[1];



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

            const key =

                fields[i];



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

            type ===

            "TRADE"

        ) {

            foundTrade = true;

        }



        if (

            type ===

            "DEPTH"

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

   ========================================================= */



async function testFinalDatabaseConsistency(): Promise<void> {

    logSection(

        "TEST 10: DATABASE CONSISTENCY",

    );



    const balances =

        await prisma.balance.findMany();



    assert(

        balances.length > 0,

        "No balances found",

    );



    for (const balance of balances) {

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

        await prisma.order.findMany();



    assert(

        orders.length > 0,

        "No orders found",

    );



    for (const order of orders) {

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



    await testBackendRoot();



    const {

        buyer,

        seller,

    } =

        await createTestUsers();



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



    await testFinalDatabaseConsistency();



    logSection(

        "ALL BACKEND E2E TESTS PASSED",

    );



    console.log(

        "Backend E2E verification complete.",

    );

}



main()

    .catch((error: unknown) => {

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

    })

    .finally(async () => {

        await redis.quit();

        await prisma.$disconnect();

    });