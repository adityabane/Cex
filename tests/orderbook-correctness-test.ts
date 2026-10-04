import { randomUUID } from "crypto";
import { prisma } from "../apps/engine/db.ts";
import { createBalance } from "../apps/engine/balance.ts";
import { createOrderInDb } from "../apps/engine/order.ts";
import {
    matchBuyOrder,
    matchSellOrder,
} from "../apps/engine/matching-engine.ts";

type TestUser = {
    id: string;
    email: string;
};

function assert(
    condition: boolean,
    message: string,
) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function createTestUser(
    prefix: string,
): Promise<TestUser> {
    return prisma.user.create({
        data: {
            email: `${prefix}-${randomUUID()}@orderbook.test`,
            passwordHash: "test-password-hash",
        },
    });
}

async function getOrder(orderId: string) {
    const order = await prisma.order.findUnique({
        where: {
            id: orderId,
        },
    });

    if (!order) {
        throw new Error(`Order ${orderId} not found`);
    }

    return order;
}

async function cleanupUsers(userIds: string[]) {
    const orders = await prisma.order.findMany({
        where: {
            userId: {
                in: userIds,
            },
        },
        select: {
            id: true,
        },
    });

    const orderIds = orders.map(
        (order) => order.id,
    );

    if (orderIds.length > 0) {
        await prisma.trade.deleteMany({
            where: {
                OR: [
                    {
                        buyOrderId: {
                            in: orderIds,
                        },
                    },
                    {
                        sellOrderId: {
                            in: orderIds,
                        },
                    },
                ],
            },
        });

        await prisma.order.deleteMany({
            where: {
                id: {
                    in: orderIds,
                },
            },
        });
    }

    await prisma.balance.deleteMany({
        where: {
            userId: {
                in: userIds,
            },
        },
    });

    await prisma.user.deleteMany({
        where: {
            id: {
                in: userIds,
            },
        },
    });
}

async function testBestPricePriority() {
    console.log(
        "\n========================================",
    );
    console.log("TEST 1: BEST-PRICE PRIORITY");
    console.log(
        "========================================",
    );

    const seller = await createTestUser("best-price-seller");
    const buyer = await createTestUser("best-price-buyer");

    try {
        await createBalance(
            seller.id,
            "BTC",
            2,
        );

        await createBalance(
            seller.id,
            "USDT",
            0,
        );

        await createBalance(
            buyer.id,
            "USDT",
            200,
        );

        await createBalance(
            buyer.id,
            "BTC",
            0,
        );

        const expensiveSell = await createOrderInDb(
            randomUUID(),
            seller.id,
            "SELL",
            "LIMIT",
            1,
            110,
        );

        const cheapSell = await createOrderInDb(
            randomUUID(),
            seller.id,
            "SELL",
            "LIMIT",
            1,
            100,
        );

        const buy = await createOrderInDb(
            randomUUID(),
            buyer.id,
            "BUY",
            "LIMIT",
            1,
            110,
        );

        await matchBuyOrder(buy.id);

        const trades = await prisma.trade.findMany({
            where: {
                buyOrderId: buy.id,
            },
            orderBy: {
                createdAt: "asc",
            },
        });
        if(trades[0]===undefined){
            throw new Error("trades are undefined");
        }
        
        assert(
            trades.length === 1,
            `Expected exactly 1 trade, got ${trades.length}`,
        );

        assert(
            Number(trades[0].price) === 100,
            `Expected trade price 100, got ${trades[0].price}`,
        );

        assert(
            trades[0].sellOrderId === cheapSell.id,
            "BUY did not match the lowest-priced SELL",
        );

        const cheapSellAfter =
            await getOrder(cheapSell.id);

        const expensiveSellAfter =
            await getOrder(expensiveSell.id);

        assert(
            cheapSellAfter.status === "FILLED",
            "Cheapest SELL should be FILLED",
        );

        assert(
            Number(
                cheapSellAfter.remainingQty,
            ) === 0,
            "Cheapest SELL should have 0 remaining quantity",
        );

        assert(
            expensiveSellAfter.status === "OPEN",
            "More expensive SELL should remain OPEN",
        );

        console.log(
            "Trade price:",
            trades[0].price.toString(),
        );

        console.log(
            "✅ Lowest-priced SELL was selected",
        );

    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

async function testTimePriority() {
    
    console.log(
        "\n========================================",
    );
    console.log("TEST 2: TIME PRIORITY");
    console.log(
        "========================================",
    );

    const sellerA =
        await createTestUser("time-seller-a");

    const sellerB =
        await createTestUser("time-seller-b");

    const buyer =
        await createTestUser("time-buyer");

    try {
        await createBalance(
            sellerA.id,
            "BTC",
            1,
        );

        await createBalance(
            sellerA.id,
            "USDT",
            0,
        );

        await createBalance(
            sellerB.id,
            "BTC",
            1,
        );

        await createBalance(
            sellerB.id,
            "USDT",
            0,
        );

        await createBalance(
            buyer.id,
            "USDT",
            100,
        );

        await createBalance(
            buyer.id,
            "BTC",
            0,
        );

        const olderSell =
            await createOrderInDb(
                randomUUID(),
                sellerA.id,
                "SELL",
                "LIMIT",
                1,
                100,
            );

        // Ensure the second order definitely has
        // a later createdAt timestamp.
        await new Promise((resolve) =>
            setTimeout(resolve, 20),
        );

        const newerSell =
            await createOrderInDb(
                randomUUID(),
                sellerB.id,
                "SELL",
                "LIMIT",
                1,
                100,
            );

        const buy = await createOrderInDb(
            randomUUID(),
            buyer.id,
            "BUY",
            "LIMIT",
            1,
            100,
        );

        await matchBuyOrder(buy.id);

        const trades = await prisma.trade.findMany({
            where: {
                buyOrderId: buy.id,
            },
        });
        if(trades[0]===undefined){
            throw new Error("trades are undefined");
        }
        assert(
            trades.length === 1,
            `Expected exactly 1 trade, got ${trades.length}`,
        );

        assert(
            trades[0].sellOrderId === olderSell.id,
            "Older SELL should have priority at the same price",
        );

        const olderAfter =
            await getOrder(olderSell.id);

        const newerAfter =
            await getOrder(newerSell.id);

        assert(
            olderAfter.status === "FILLED",
            "Older SELL should be FILLED",
        );

        assert(
            newerAfter.status === "OPEN",
            "Newer SELL should remain OPEN",
        );

        console.log(
            "Older SELL:",
            olderSell.id,
        );

        console.log(
            "Newer SELL:",
            newerSell.id,
        );

        console.log(
            "Matched SELL:",
            trades[0].sellOrderId,
        );

        console.log(
            "✅ Price-time priority is correct",
        );

    } finally {
        await cleanupUsers([
            sellerA.id,
            sellerB.id,
            buyer.id,
        ]);
    }
}

async function testPartialFill() {
    console.log(
        "\n========================================",
    );
    console.log("TEST 3: PARTIAL FILL");
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser("partial-seller");

    const buyer =
        await createTestUser("partial-buyer");

    try {
        await createBalance(
            seller.id,
            "BTC",
            2,
        );

        await createBalance(
            seller.id,
            "USDT",
            0,
        );

        await createBalance(
            buyer.id,
            "USDT",
            100,
        );

        await createBalance(
            buyer.id,
            "BTC",
            0,
        );

        const sell = await createOrderInDb(
            randomUUID(),
            seller.id,
            "SELL",
            "LIMIT",
            2,
            100,
        );

        const buy = await createOrderInDb(
            randomUUID(),
            buyer.id,
            "BUY",
            "LIMIT",
            1,
            100,
        );

        await matchBuyOrder(buy.id);

        const sellAfter =
            await getOrder(sell.id);

        const buyAfter =
            await getOrder(buy.id);

        const trades = await prisma.trade.findMany({
            where: {
                OR: [
                    {
                        buyOrderId: buy.id,
                    },
                    {
                        sellOrderId: sell.id,
                    },
                ],
            },
        });

        assert(
            trades.length === 1,
            `Expected 1 trade, got ${trades.length}`,
        );
        if(trades[0]===undefined){
            throw new Error("trades are undefined");
        }
        assert(
            Number(trades[0].quantity) === 1,
            `Expected trade quantity 1, got ${trades[0].quantity}`,
        );

        assert(
            buyAfter.status === "FILLED",
            "BUY should be FILLED",
        );

        assert(
            Number(buyAfter.remainingQty) === 0,
            "BUY should have 0 remaining quantity",
        );

        assert(
            sellAfter.status === "PARTIALLY_FILLED",
            "SELL should be PARTIALLY_FILLED",
        );

        assert(
            Number(sellAfter.remainingQty) === 1,
            `SELL should have 1 BTC remaining, got ${sellAfter.remainingQty}`,
        );

        console.log(
            "SELL remaining:",
            sellAfter.remainingQty.toString(),
        );

        console.log(
            "BUY remaining:",
            buyAfter.remainingQty.toString(),
        );

        console.log(
            "✅ Partial fill is correct",
        );

    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

async function testMultiplePriceLevels() {
    console.log(
        "\n========================================",
    );
    console.log("TEST 4: MULTIPLE PRICE LEVELS");
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser("levels-seller");

    const buyer =
        await createTestUser("levels-buyer");

    try {
        await createBalance(
            seller.id,
            "BTC",
            6,
        );

        await createBalance(
            seller.id,
            "USDT",
            0,
        );

        await createBalance(
            buyer.id,
            "USDT",
            500,
        );

        await createBalance(
            buyer.id,
            "BTC",
            0,
        );

        const sell100 =
            await createOrderInDb(
                randomUUID(),
                seller.id,
                "SELL",
                "LIMIT",
                1,
                100,
            );

        const sell105 =
            await createOrderInDb(
                randomUUID(),
                seller.id,
                "SELL",
                "LIMIT",
                2,
                105,
            );

        const sell110 =
            await createOrderInDb(
                randomUUID(),
                seller.id,
                "SELL",
                "LIMIT",
                3,
                110,
            );

        const buy = await createOrderInDb(
            randomUUID(),
            buyer.id,
            "BUY",
            "LIMIT",
            4,
            110,
        );

        await matchBuyOrder(buy.id);

        const trades = await prisma.trade.findMany({
            where: {
                buyOrderId: buy.id,
            },
            orderBy: {
                createdAt: "asc",
            },
        });

        assert(
            trades.length === 3,
            `Expected 3 trades, got ${trades.length}`,
        );
        
        if(trades[0]===undefined){
            throw new Error("trades are undefined");
        }
        if(trades[1]===undefined){
            throw new Error("trades are undefined");
        }
        if(trades[2]===undefined){
            throw new Error("trades are undefined");
        }
        const totalQuantity =
            trades.reduce(
                (total, trade) =>
                    total + Number(trade.quantity),
                0,
            );

        assert(
            totalQuantity === 4,
            `Expected 4 BTC traded, got ${totalQuantity}`,
        );
        assert(
            Number(trades[0].price) === 100,
            `First trade should be @100, got ${trades[0].price}`,
        );

        assert(
            Number(trades[0].quantity) === 1,
            `First trade should be 1 BTC, got ${trades[0].quantity}`,
        );

        assert(
            Number(trades[1].price) === 105,
            `Second trade should be @105, got ${trades[1].price}`,
        );

        assert(
            Number(trades[1].quantity) === 2,
            `Second trade should be 2 BTC, got ${trades[1].quantity}`,
        );

        assert(
            Number(trades[2].price) === 110,
            `Third trade should be @110, got ${trades[2].price}`,
        );

        assert(
            Number(trades[2].quantity) === 1,
            `Third trade should be 1 BTC, got ${trades[2].quantity}`,
        );

        const sell100After =
            await getOrder(sell100.id);

        const sell105After =
            await getOrder(sell105.id);

        const sell110After =
            await getOrder(sell110.id);

        assert(
            sell100After.status === "FILLED",
            "100 SELL should be FILLED",
        );

        assert(
            sell105After.status === "FILLED",
            "105 SELL should be FILLED",
        );

        assert(
            sell110After.status ===
                "PARTIALLY_FILLED",
            "110 SELL should be PARTIALLY_FILLED",
        );

        assert(
            Number(
                sell110After.remainingQty,
            ) === 2,
            `110 SELL should have 2 BTC remaining, got ${sell110After.remainingQty}`,
        );

        const buyAfter =
            await getOrder(buy.id);

        assert(
            buyAfter.status === "FILLED",
            "BUY should be FILLED",
        );

        assert(
            Number(buyAfter.remainingQty) === 0,
            "BUY should have 0 remaining quantity",
        );

        console.log(
            "\nExecuted trades:",
        );

        for (const trade of trades) {
            console.log(
                `Price: ${trade.price} | Quantity: ${trade.quantity}`,
            );
        }

        console.log(
            "\nRemaining at 110:",
            sell110After.remainingQty.toString(),
        );

        console.log(
            "✅ Multiple price levels matched correctly",
        );

    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

async function main() {
    console.log(
        "========================================",
    );
    console.log(
        "   CEX V2 ORDER-BOOK CORRECTNESS TEST",
    );
    console.log(
        "========================================",
    );

    await testBestPricePriority();

    await testTimePriority();

    await testPartialFill();

    await testMultiplePriceLevels();

    console.log(
        "\n========================================",
    );
    console.log(
        "   ✅ ALL ORDER-BOOK TESTS PASSED",
    );
    console.log(
        "========================================",
    );
}

main()
    .catch((error) => {
        console.error(
            "\n========================================",
        );
        console.error(
            "   ❌ ORDER-BOOK TEST FAILED",
        );
        console.error(
            "========================================",
        );

        console.error(error);

        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });