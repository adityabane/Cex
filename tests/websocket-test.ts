const API_URL = "http://localhost:3000";
const WS_URL = "ws://localhost:3001";

const PASSWORD = "TestPassword123!";

function assert(condition: boolean, message: string) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function createUser() {
    const email = `ws-test-${crypto.randomUUID()}@example.com`;

    const response = await fetch(`${API_URL}/users`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            email,
            password: PASSWORD,
        }),
    });

    assert(response.ok, `Failed to create user: ${await response.text()}`);

    const user:any = await response.json();

    const loginResponse = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            email,
            password: PASSWORD,
        }),
    });

    assert(
        loginResponse.ok,
        `Failed to login user: ${await loginResponse.text()}`
    );

    const loginData:any = await loginResponse.json();

    return {
        id: user.id as string,
        token: loginData.token as string,
    };
}

async function createBalance(
    userId: string,
    token: string,
    asset: string,
    amount: number,
) {
    const response = await fetch(
        `${API_URL}/users/${userId}/balances`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                asset,
                amount,
            }),
        }
    );

    assert(
        response.ok,
        `Failed to create ${asset} balance: ${await response.text()}`
    );
}

function waitForMessageType(
    ws: WebSocket,
    type: string,
    timeoutMs = 5000,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.removeEventListener("message", handler);
            reject(
                new Error(
                    `Timed out waiting for WebSocket message type: ${type}`
                )
            );
        }, timeoutMs);

        function handler(event: MessageEvent) {
            try {
                const data = JSON.parse(event.data.toString());

                if (data.type === type) {
                    clearTimeout(timeout);
                    ws.removeEventListener("message", handler);
                    resolve(data);
                }
            } catch {
                // Ignore invalid/non-JSON messages.
            }
        }

        ws.addEventListener("message", handler);
    });
}

function waitForNoMessageType(
    ws: WebSocket,
    type: string,
    timeoutMs = 2000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.removeEventListener("message", handler);
            resolve();
        }, timeoutMs);

        function handler(event: MessageEvent) {
            try {
                const data = JSON.parse(event.data.toString());

                if (data.type === type) {
                    clearTimeout(timeout);
                    ws.removeEventListener("message", handler);
                    reject(
                        new Error(
                            `Received unexpected ${type} message`
                        )
                    );
                }
            } catch {
                // Ignore invalid/non-JSON messages.
            }
        }

        ws.addEventListener("message", handler);
    });
}

function connectWebSocket(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(
            `${WS_URL}?token=${encodeURIComponent(token)}`
        );

        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("Timed out connecting to WebSocket"));
        }, 5000);

        ws.addEventListener("open", () => {
            waitForMessageType(ws, "CONNECTED")
                .then(() => {
                    clearTimeout(timeout);
                    resolve(ws);
                })
                .catch(reject);
        });

        ws.addEventListener("error", () => {
            clearTimeout(timeout);
            reject(new Error("WebSocket connection failed"));
        });
    });
}

async function testUnauthenticatedWebSocket() {
    console.log("\n1. Testing WebSocket authentication...");

    const noTokenResponse = await fetch("http://localhost:3001");

    assert(
        noTokenResponse.status === 401,
        `Expected 401 without token, got ${noTokenResponse.status}`
    );

    const invalidTokenResponse = await fetch(
        `http://localhost:3001?token=invalid-token`
    );

    assert(
        invalidTokenResponse.status === 401,
        `Expected 401 with invalid token, got ${invalidTokenResponse.status}`
    );

    console.log("   ✅ Missing token rejected");
    console.log("   ✅ Invalid token rejected");
}

async function testAuthenticatedWebSocket() {
    console.log("\n2. Creating test users...");

    const userA = await createUser();
    const userB = await createUser();

    console.log(`   User A: ${userA.id}`);
    console.log(`   User B: ${userB.id}`);

    await createBalance(
        userA.id,
        userA.token,
        "USDT",
        100,
    );

    console.log("   ✅ User A funded with 100 USDT");

    console.log("\n3. Connecting authenticated WebSockets...");

    const wsA = await connectWebSocket(userA.token);
    const wsB = await connectWebSocket(userB.token);

    console.log("   ✅ User A connected");
    console.log("   ✅ User B connected");

    try {
        console.log("\n4. Testing order subscriptions...");

        wsA.send(`SUBSCRIBE orders.${userA.id}`);

        const subscribedA = await waitForMessageType(
            wsA,
            "SUBSCRIBED"
        );

        assert(
            subscribedA.stream === `orders.${userA.id}`,
            "User A subscribed to wrong order stream"
        );

        console.log("   ✅ User A subscribed to own orders");

        wsB.send(`SUBSCRIBE orders.${userB.id}`);

        const subscribedB = await waitForMessageType(
            wsB,
            "SUBSCRIBED"
        );

        assert(
            subscribedB.stream === `orders.${userB.id}`,
            "User B subscribed to wrong order stream"
        );

        console.log("   ✅ User B subscribed to own orders");

        console.log("\n5. Testing private subscription authorization...");

        wsB.send(`SUBSCRIBE orders.${userA.id}`);

        const unauthorizedSubscribe = await waitForMessageType(
            wsB,
            "ERROR"
        );

        assert(
            unauthorizedSubscribe.message ===
                "Unauthorized order subscription",
            `Unexpected authorization error: ${unauthorizedSubscribe.message}`
        );

        console.log("   ✅ User B cannot subscribe to User A's orders");

        wsB.send(`UNSUBSCRIBE orders.${userA.id}`);

        const unauthorizedUnsubscribe = await waitForMessageType(
            wsB,
            "ERROR"
        );

        assert(
            unauthorizedUnsubscribe.message ===
                "Unauthorized order subscription",
            "Unauthorized unsubscribe was not rejected"
        );

        console.log("   ✅ User B cannot unsubscribe from User A's orders");

        console.log("\n6. Testing depth subscription and snapshot...");

        wsA.send("SUBSCRIBE depth.BTC");

        const depthSubscribed = await waitForMessageType(
            wsA,
            "SUBSCRIBED"
        );

        assert(
            depthSubscribed.stream === "depth.BTC",
            "Depth subscription failed"
        );

        const snapshot = await waitForMessageType(
            wsA,
            "DEPTH_SNAPSHOT"
        );

        assert(
            snapshot.bids !== undefined,
            "Depth snapshot missing bids"
        );

        assert(
            snapshot.asks !== undefined,
            "Depth snapshot missing asks"
        );

        console.log("   ✅ BTC depth subscription works");
        console.log("   ✅ BTC depth snapshot received");

        console.log("\n7. Testing private ORDER_STATUS routing...");

        /*
         * Start listeners BEFORE creating the order.
         * This prevents a race where the Redis consumer could
         * process the event before the test starts listening.
         */
        const userAOrderPromise = waitForMessageType(
            wsA,
            "ORDER_STATUS",
            10000
        );

        const userBLeakPromise = waitForNoMessageType(
            wsB,
            "ORDER_STATUS",
            3000
        );

        const orderResponse = await fetch(`${API_URL}/orders`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${userA.token}`,
            },
            body: JSON.stringify({
                side: "BUY",
                type: "LIMIT",
                qty: 0.01,
                price: 1,
            }),
        });

        assert(
            orderResponse.status === 201,
            `Failed to create order: ${await orderResponse.text()}`
        );

        const orderData:any = await orderResponse.json();

        console.log(`   Order created: ${orderData.orderId}`);

        const orderStatus = await userAOrderPromise;

        assert(
            orderStatus.type === "ORDER_STATUS",
            "User A did not receive ORDER_STATUS"
        );

        assert(
            orderStatus.userId === userA.id,
            "ORDER_STATUS belongs to wrong user"
        );

        assert(
            orderStatus.orderId === orderData.orderId,
            "ORDER_STATUS belongs to wrong order"
        );

        await userBLeakPromise;

        console.log("   ✅ User A received own ORDER_STATUS");
        console.log("   ✅ User B did not receive User A's ORDER_STATUS");

        console.log("\n8. Testing live DEPTH event...");

        /*
         * The order above should create a BTC bid at price 1,
         * producing a DEPTH event.
         */
        const depthEvent = await waitForMessageType(
            wsA,
            "DEPTH",
            10000
        );

        assert(
            depthEvent.asset === "BTC",
            `Expected BTC depth event, got ${depthEvent.asset}`
        );

        assert(
            Array.isArray(depthEvent.bids),
            "DEPTH bids should be an array"
        );

        assert(
            Array.isArray(depthEvent.asks),
            "DEPTH asks should be an array"
        );

        console.log("   ✅ Live DEPTH event received");
        console.log("   ✅ DEPTH bids/asks parsed correctly");

        console.log("\n9. Testing unsubscribe...");

        wsA.send("UNSUBSCRIBE depth.BTC");

        const unsubscribed = await waitForMessageType(
            wsA,
            "UNSUBSCRIBED"
        );

        assert(
            unsubscribed.stream === "depth.BTC",
            "Wrong stream unsubscribed"
        );

        console.log("   ✅ Depth unsubscribe works");

        console.log("\n========================================");
        console.log("   ✅ ALL WEBSOCKET TESTS PASSED");
        console.log("========================================");
    } finally {
        wsA.close();
        wsB.close();
    }
}

async function main() {
    console.log("========================================");
    console.log("       CEX WEBSOCKET TEST SUITE");
    console.log("========================================");

    await testUnauthenticatedWebSocket();
    await testAuthenticatedWebSocket();
}

try {
    await main();
} catch (error) {
    console.error("\n========================================");
    console.error("   ❌ WEBSOCKET TEST FAILED");
    console.error("========================================");
    console.error(error);
    process.exit(1);
}