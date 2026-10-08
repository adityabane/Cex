const BASE_URL = "http://localhost:3000";

type User = {
    id: string;
    email: string;
    token: string;
};

async function request(
    path: string,
    options: RequestInit = {},
) {
    const response = await fetch(
        `${BASE_URL}${path}`,
        {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers ?? {}),
            },
        },
    );

    const text = await response.text();

    let data: any;

    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }

    if (!response.ok) {
        throw new Error(
            `${options.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(data)}`,
        );
    }

    return data;
}

async function createUser(
    email: string,
    password: string,
): Promise<{ id: string; email: string }> {
    return request("/users", {
        method: "POST",
        body: JSON.stringify({
            email,
            password,
        }),
    });
}

async function login(
    email: string,
    password: string,
): Promise<string> {
    const data = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({
            email,
            password,
        }),
    });

    return data.token;
}

async function createAuthenticatedUser(
    name: string,
): Promise<User> {
    const email =
        `multiasset-${name}-${crypto.randomUUID()}@test.com`;

    const password = "TestPassword123!";

    const user = await createUser(
        email,
        password,
    );

    const token = await login(
        email,
        password,
    );

    return {
        id: user.id,
        email,
        token,
    };
}

async function createBalance(
    user: User,
    asset: string,
    amount: number,
): Promise<void> {
    await request(
        `/users/${user.id}/balances`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${user.token}`,
            },
            body: JSON.stringify({
                asset,
                amount,
            }),
        },
    );
}

async function getBalance(
    user: User,
    asset: string,
) {
    return request(
        `/users/${user.id}/balances/${asset}`,
        {
            headers: {
                Authorization: `Bearer ${user.token}`,
            },
        },
    );
}

async function createOrder(
    user: User,
    asset: string,
    side: "BUY" | "SELL",
    qty: number,
    price: number,
) {
    return request("/orders", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
            asset,
            side,
            type: "LIMIT",
            qty,
            price,
        }),
    });
}

async function getOrder(
    user: User,
    orderId: string,
) {
    return request(
        `/orders/${orderId}`,
        {
            headers: {
                Authorization: `Bearer ${user.token}`,
            },
        },
    );
}

async function waitForOrderFilled(
    user: User,
    orderId: string,
    timeoutMs = 15000,
) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        try {
            const order =
                await getOrder(
                    user,
                    orderId,
                );

            if (order.status === "FILLED") {
                return order;
            }

            if (
                order.status === "CANCELLED"
            ) {
                throw new Error(
                    `Order ${orderId} was cancelled`,
                );
            }
        } catch (error) {
            if (
                error instanceof Error &&
                error.message.includes("(404)")
            ) {
                // Order has not reached PostgreSQL yet.
                // Redis consumer is still processing it.
            } else {
                throw error;
            }
        }

        await Bun.sleep(500);
    }

    throw new Error(
        `Timed out waiting for order ${orderId} to become FILLED`,
    );
}

async function testAsset(
    asset: string,
    qty: number,
    price: number,
    sellerBalance: number,
) {
    console.log(
        `\n========== Testing ${asset}/USDT ==========`,
    );

    const buyer =
        await createAuthenticatedUser(
            `buyer-${asset.toLowerCase()}`,
        );

    const seller =
        await createAuthenticatedUser(
            `seller-${asset.toLowerCase()}`,
        );

    console.log(
        "Buyer:",
        buyer.email,
    );

    console.log(
        "Seller:",
        seller.email,
    );

    /*
     * Buyer needs USDT.
     * Seller needs the base asset.
     */
    await createBalance(
        buyer,
        "USDT",
        qty * price + 1000,
    );

    await createBalance(
        seller,
        asset,
        sellerBalance,
    );
    const buyerUSDT =
    await getBalance(
        buyer,
        "USDT",
    );

const sellerAsset =
    await getBalance(
        seller,
        asset,
    );

console.log(
    "BUYER USDT BEFORE ORDER:",
    buyerUSDT,
);

console.log(
    `SELLER ${asset} BEFORE ORDER:`,
    sellerAsset,
);

    console.log(
        `Balances created for ${asset}`,
    );

    /*
     * Buyer places BUY order.
     */
    const buy =
        await createOrder(
            buyer,
            asset,
            "BUY",
            qty,
            price,
        );

    console.log(
        "BUY queued:",
        buy.orderId,
    );

    /*
     * Seller places matching SELL order.
     */
    const sell =
        await createOrder(
            seller,
            asset,
            "SELL",
            qty,
            price,
        );

    console.log(
        "SELL queued:",
        sell.orderId,
    );

    /*
     * Wait for both orders to be processed.
     */
    const filledBuy =
        await waitForOrderFilled(
            buyer,
            buy.orderId,
        );

    const filledSell =
        await waitForOrderFilled(
            seller,
            sell.orderId,
        );

    console.log(
        "BUY status:",
        filledBuy.status,
    );

    console.log(
        "SELL status:",
        filledSell.status,
    );

    /*
     * Verify buyer received the correct asset.
     */
    const buyerAssetBalance =
        await getBalance(
            buyer,
            asset,
        );

    /*
     * Verify seller received USDT.
     */
    const sellerUSDTBalance =
        await getBalance(
            seller,
            "USDT",
        );

    console.log(
        `Buyer ${asset} balance:`,
        buyerAssetBalance,
    );

    console.log(
        "Seller USDT balance:",
        sellerUSDTBalance,
    );

    const buyerAssetAvailable =
        Number(
            buyerAssetBalance.available,
        );

    const sellerUSDTAvailable =
        Number(
            sellerUSDTBalance.available,
        );

    if (
        buyerAssetAvailable < qty
    ) {
        throw new Error(
            `FAIL: Buyer did not receive ${qty} ${asset}`,
        );
    }

    const expectedUSDT =
        qty * price;

    if (
        sellerUSDTAvailable <
        expectedUSDT
    ) {
        throw new Error(
            `FAIL: Seller did not receive ${expectedUSDT} USDT`,
        );
    }

    console.log(
        `PASS: ${asset}/USDT trade settled correctly`,
    );

    return {
        buyer,
        seller,
        buy,
        sell,
    };
}

async function main() {
    console.log(
        "Starting multi-asset CEX E2E test...",
    );

    /*
     * Check backend.
     */
    const health =
        await request("/");

    console.log(
        "Backend:",
        health,
    );

    /*
     * ETH/USDT
     */
    await testAsset(
        "ETH",
        2,
        2000,
        2,
    );

    /*
     * SOL/USDT
     */
    await testAsset(
        "SOL",
        5,
        100,
        5,
    );

    console.log(
        "\n====================================",
    );

    console.log(
        "ALL MULTI-ASSET TESTS PASSED",
    );

    console.log(
        "====================================",
    );
}

main().catch((error) => {
    console.error(
        "\nMULTI-ASSET TEST FAILED",
    );

    console.error(error);

    process.exit(1);
});