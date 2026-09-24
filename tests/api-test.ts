const BASE_URL = "http://localhost:3000";

type User = {
    id: string;
    email: string;
    password: string;
};

type LoginResponse = {
    token: string;
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
    console.log("Response:", JSON.stringify(response.body, null, 2));
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

    if (!response.ok) {
        throw new Error(`Failed to create user: ${response.status}`);
    }

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

    if (!response.ok) {
        throw new Error(`Login failed: ${response.status}`);
    }

    const data = response.body as LoginResponse;

    if (!data.token) {
        throw new Error("Login response did not contain token");
    }

    return data.token;
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

    if (!response.ok) {
        throw new Error(
            `Failed to create balance ${asset}: ${response.status}`,
        );
    }

    return response.body;
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

async function createOrder(
    order: {
        symbol: string;
        side: "BUY" | "SELL";
        price: number;
        quantity: number;
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

async function waitForOrder(
    orderId: string,
    token: string,
    timeoutMs = 15000,
) {
    const start = Date.now();

    console.log(`\nWaiting for order ${orderId}...`);

    let lastResponse: any = null;

    while (Date.now() - start < timeoutMs) {
        lastResponse = await getOrder(orderId, token);

        if (lastResponse.ok) {
            const status = lastResponse.body.status;

            console.log(
                `Order status: ${status} (${Date.now() - start}ms)`,
            );

            return lastResponse.body;
        }

        console.log(
            `GET /orders/${orderId} -> ${lastResponse.status}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return null;
}

async function main() {
    console.log("========================================");
    console.log("CEX V2 ORDER PIPELINE DIAGNOSTIC TEST");
    console.log("========================================");

    console.log("\n1. Checking backend...");

    const root = await request("/");

    logResponse("GET /", root);

    if (!root.ok) {
        throw new Error(
            "Backend is not responding correctly.",
        );
    }

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

    console.log("\n2. Logging in users...");

    const tokenA = await login(userA);
    const tokenB = await login(userB);

    console.log("\nJWT login successful.");

    console.log("\n3. Creating balances...");

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

    console.log("\n4. Creating isolated BUY order...");

    /*
     * IMPORTANT:
     *
     * We intentionally use a very unusual price so this order
     * should not accidentally match normal existing liquidity.
     *
     * If your engine supports only a specific symbol, keep the
     * symbol consistent with your project.
     */
    const buyOrder = {
        symbol: "BTC_USDT",
        side: "BUY" as const,
        price: 1,
        quantity: 1,
    };

    const createResponse = await createOrder(
        buyOrder,
        tokenA,
    );

    if (!createResponse.ok) {
        console.log("\n❌ ORDER CREATION FAILED");
        console.log(
            "The backend rejected the POST /orders request.",
        );

        process.exit(1);
    }

    const orderId =
        createResponse.body.id ??
        createResponse.body.orderId;

    if (!orderId) {
        console.log(
            "\n❌ POST /orders succeeded but no order ID was returned.",
        );

        console.log(
            "This is the exact backend response:",
        );

        console.log(
            JSON.stringify(
                createResponse.body,
                null,
                2,
            ),
        );

        process.exit(1);
    }

    console.log(`\nCreated order: ${orderId}`);

    console.log("\n5. Checking order immediately...");

    const immediate = await getOrder(
        orderId,
        tokenA,
    );

    logResponse(
        "IMMEDIATE GET /orders/:orderId",
        immediate,
    );

    if (immediate.ok) {
        console.log(
            "\n✅ ORDER ALREADY EXISTS IN DATABASE.",
        );

        console.log(
            `Current status: ${immediate.body.status}`,
        );

        console.log(
            "\nThe POST → Redis → Engine → Prisma pipeline worked.",
        );

        if (immediate.body.status === "OPEN") {
            console.log(
                "✅ Order reached OPEN immediately.",
            );
        }

        if (immediate.body.status === "FILLED") {
            console.log(
                "⚠️ Order was immediately FILLED.",
            );
        }

        return;
    }

    if (immediate.status === 404) {
        console.log(
            "\n⚠️ Order does NOT exist in the database yet.",
        );

        console.log(
            "This means we need to check the Redis → Engine → Prisma pipeline.",
        );
    }

    console.log(
        "\n6. Waiting for engine to process the order...",
    );

    const finalOrder = await waitForOrder(
        orderId,
        tokenA,
        15000,
    );

    if (!finalOrder) {
        console.log("\n========================================");
        console.log("❌ DIAGNOSTIC RESULT");
        console.log("========================================");

        console.log(
            `Order ${orderId} was created by POST /orders`,
        );

        console.log(
            "but was NOT found in the database after 15 seconds.",
        );

        console.log("\nLikely pipeline:");

        console.log("POST /orders       ✅");
        console.log("Redis publish      ❓");
        console.log("Engine consumer    ❓");
        console.log("Prisma create      ❌");
        console.log("Neon Order row     ❌");

        console.log(
            "\n👉 Check the ENGINE TERMINAL now.",
        );

        console.log(
            "There should be a log showing whether the order was received.",
        );

        console.log("\nOrder ID:");

        console.log(orderId);

        process.exit(1);
    }

    console.log("\n========================================");
    console.log("✅ DIAGNOSTIC RESULT");
    console.log("========================================");

    console.log(
        JSON.stringify(finalOrder, null, 2),
    );

    console.log(
        `\nFinal status: ${finalOrder.status}`,
    );

    if (
        finalOrder.status === "OPEN"
    ) {
        console.log(
            "\n✅ POST → Redis → Engine → Prisma → OPEN works.",
        );
    } else if (
        finalOrder.status === "FILLED"
    ) {
        console.log(
            "\n⚠️ Order was matched immediately.",
        );
    } else {
        console.log(
            "\nOrder reached the database but has an unexpected status.",
        );
    }
}

main().catch((error) => {
    console.error("\n========================================");
    console.error("❌ TEST CRASHED");
    console.error("========================================");

    console.error(error);

    process.exit(1);
});