import { randomUUID } from "crypto";
import { prisma } from "../apps/engine/db.ts";
import { createBalance } from "../apps/engine/balance.ts";
import { createOrderInDb } from "../apps/engine/order.ts";
import {
    matchBuyOrder,
    matchSellOrder,
} from "../apps/engine/matching-engine.ts";

function assert(
    condition: boolean,
    message: string,
) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function createTestUser(prefix: string) {
    return prisma.user.create({
        data: {
            email: `${prefix}-${randomUUID()}@market.test`,
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
        throw new Error(
            `Order ${orderId} not found`,
        );
    }

    return order;
}

async function cleanupUsers(
    userIds: string[],
) {
    const orders =
        await prisma.order.findMany({
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

/* ============================================================
   TEST 1
   MARKET BUY consumes multiple ASK price levels.
   ============================================================ */

async function testMarketBuyMultipleLevels() {
    console.log(
        "\n========================================",
    );
    console.log(
        "TEST 1: MARKET BUY - MULTIPLE LEVELS",
    );
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser(
            "market-buy-levels-seller",
        );

    const buyer =
        await createTestUser(
            "market-buy-levels-buyer",
        );

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

        const marketBuy =
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "MARKET",
                4,
            );

        await matchBuyOrder(
            marketBuy.id,
        );

        const trades =
            await prisma.trade.findMany({
                where: {
                    buyOrderId:
                        marketBuy.id,
                },
            });

        assert(
            trades.length === 3,
            `Expected 3 trades, got ${trades.length}`,
        );

        const trade100 =
            trades.find(
                (trade) =>
                    trade.sellOrderId ===
                    sell100.id,
            );

        const trade105 =
            trades.find(
                (trade) =>
                    trade.sellOrderId ===
                    sell105.id,
            );

        const trade110 =
            trades.find(
                (trade) =>
                    trade.sellOrderId ===
                    sell110.id,
            );

        assert(
            trade100 !== undefined,
            "Expected trade against 100 SELL",
        );

        assert(
            trade105 !== undefined,
            "Expected trade against 105 SELL",
        );

        assert(
            trade110 !== undefined,
            "Expected trade against 110 SELL",
        );

        assert(
            Number(trade100!.price) === 100,
            `Expected 100 trade price 100, got ${trade100!.price}`,
        );

        assert(
            Number(trade100!.quantity) === 1,
            `Expected 100 trade quantity 1, got ${trade100!.quantity}`,
        );

        assert(
            Number(trade105!.price) === 105,
            `Expected 105 trade price 105, got ${trade105!.price}`,
        );

        assert(
            Number(trade105!.quantity) === 2,
            `Expected 105 trade quantity 2, got ${trade105!.quantity}`,
        );

        assert(
            Number(trade110!.price) === 110,
            `Expected 110 trade price 110, got ${trade110!.price}`,
        );

        assert(
            Number(trade110!.quantity) === 1,
            `Expected 110 trade quantity 1, got ${trade110!.quantity}`,
        );

        const buyAfter =
            await getOrder(
                marketBuy.id,
            );

        assert(
            buyAfter.status === "FILLED",
            `Expected MARKET BUY FILLED, got ${buyAfter.status}`,
        );

        assert(
            Number(
                buyAfter.remainingQty,
            ) === 0,
            "MARKET BUY should have 0 remaining quantity",
        );

        const sell100After =
            await getOrder(
                sell100.id,
            );

        const sell105After =
            await getOrder(
                sell105.id,
            );

        const sell110After =
            await getOrder(
                sell110.id,
            );

        assert(
            sell100After.status ===
                "FILLED",
            "100 SELL should be FILLED",
        );

        assert(
            sell105After.status ===
                "FILLED",
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
            `Expected 2 BTC remaining at 110, got ${sell110After.remainingQty}`,
        );

        console.log(
            "100 × 1",
        );

        console.log(
            "105 × 2",
        );

        console.log(
            "110 × 1",
        );

        console.log(
            "✅ MARKET BUY consumed multiple price levels correctly",
        );
    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

/* ============================================================
   TEST 2
   MARKET BUY larger than available liquidity should be
   rejected before the order is created.
   ============================================================ */

async function testMarketBuyInsufficientLiquidity() {
    console.log(
        "\n========================================",
    );
    console.log(
        "TEST 2: MARKET BUY - INSUFFICIENT LIQUIDITY",
    );
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser(
            "market-buy-insufficient-seller",
        );

    const buyer =
        await createTestUser(
            "market-buy-insufficient-buyer",
        );

    try {
        await createBalance(
            seller.id,
            "BTC",
            1,
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

        await createOrderInDb(
            randomUUID(),
            seller.id,
            "SELL",
            "LIMIT",
            1,
            100,
        );

        let rejected = false;

        try {
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "MARKET",
                2,
            );
        } catch (error) {
            rejected = true;

            console.log(
                "Order rejected:",
                error instanceof Error
                    ? error.message
                    : error,
            );
        }

        assert(
            rejected,
            "MARKET BUY should be rejected when liquidity is insufficient",
        );

        const balance =
            await prisma.balance.findUnique({
                where: {
                    userId_asset: {
                        userId: buyer.id,
                        asset: "USDT",
                    },
                },
            });

        if (!balance) {
            throw new Error(
                "USDT balance not found",
            );
        }

        assert(
            Number(balance.available) ===
                500,
            `Expected available USDT 500, got ${balance.available}`,
        );

        assert(
            Number(balance.locked) ===
                0,
            `Expected locked USDT 0, got ${balance.locked}`,
        );

        const buyerOrders =
            await prisma.order.findMany({
                where: {
                    userId: buyer.id,
                },
            });

        assert(
            buyerOrders.length === 0,
            `Expected 0 buyer orders, got ${buyerOrders.length}`,
        );

        console.log(
            "Available USDT:",
            balance.available.toString(),
        );

        console.log(
            "Locked USDT:",
            balance.locked.toString(),
        );

        console.log(
            "Buyer orders:",
            buyerOrders.length,
        );

        console.log(
            "✅ Insufficient MARKET BUY liquidity handled correctly",
        );
    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

/* ============================================================
   TEST 3
   MARKET SELL consumes highest BID levels first.
   ============================================================ */

async function testMarketSellMultipleLevels() {
    console.log(
        "\n========================================",
    );
    console.log(
        "TEST 3: MARKET SELL - MULTIPLE LEVELS",
    );
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser(
            "market-sell-levels-seller",
        );

    const buyer =
        await createTestUser(
            "market-sell-levels-buyer",
        );

    try {
        /*
         * Buyer needs enough USDT for:
         *
         * 1 BTC × 110 = 110
         * 2 BTC × 105 = 210
         * 3 BTC × 100 = 300
         *
         * Total = 620 USDT
         */

        await createBalance(
            seller.id,
            "BTC",
            4,
        );

        await createBalance(
            seller.id,
            "USDT",
            0,
        );

        await createBalance(
            buyer.id,
            "USDT",
            700,
        );

        await createBalance(
            buyer.id,
            "BTC",
            0,
        );

        /*
         * Create the three BID levels.
         */

        const buy110 =
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "LIMIT",
                1,
                110,
            );

        const buy105 =
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "LIMIT",
                2,
                105,
            );

        const buy100 =
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "LIMIT",
                3,
                100,
            );

        /*
         * Verify that the orders actually exist
         * with the expected prices before matching.
         *
         * This prevents a stale-data/test-cleanup issue
         * from being mistaken for a matching-engine issue.
         */

        const buy110Before =
            await getOrder(
                buy110.id,
            );

        const buy105Before =
            await getOrder(
                buy105.id,
            );

        const buy100Before =
            await getOrder(
                buy100.id,
            );

        assert(
            Number(buy110Before.price) ===
                110,
            `BUY 110 price incorrect: ${buy110Before.price}`,
        );

        assert(
            Number(buy105Before.price) ===
                105,
            `BUY 105 price incorrect: ${buy105Before.price}`,
        );

        assert(
            Number(buy100Before.price) ===
                100,
            `BUY 100 price incorrect: ${buy100Before.price}`,
        );

        assert(
            Number(
                buy110Before.remainingQty,
            ) === 1,
            "BUY 110 should start with 1 BTC",
        );

        assert(
            Number(
                buy105Before.remainingQty,
            ) === 2,
            "BUY 105 should start with 2 BTC",
        );

        assert(
            Number(
                buy100Before.remainingQty,
            ) === 3,
            "BUY 100 should start with 3 BTC",
        );

        /*
         * Create MARKET SELL for 4 BTC.
         */

        const marketSell =
            await createOrderInDb(
                randomUUID(),
                seller.id,
                "SELL",
                "MARKET",
                4,
            );

        await matchSellOrder(
            marketSell.id,
        );

        /*
         * Get all trades belonging specifically
         * to this MARKET SELL.
         */

        const trades =
            await prisma.trade.findMany({
                where: {
                    sellOrderId:
                        marketSell.id,
                },
            });

        console.log(
            "\nTrades created:",
        );

        for (const trade of trades) {
            console.log(
                `BUY ${trade.buyOrderId} | Price ${trade.price} | Quantity ${trade.quantity}`,
            );
        }

        assert(
            trades.length === 3,
            `Expected 3 trades, got ${trades.length}`,
        );

        /*
         * Identify trades by the BUY order that
         * they actually matched against.
         */

        const trade110 =
            trades.find(
                (trade) =>
                    trade.buyOrderId ===
                    buy110.id,
            );

        const trade105 =
            trades.find(
                (trade) =>
                    trade.buyOrderId ===
                    buy105.id,
            );

        const trade100 =
            trades.find(
                (trade) =>
                    trade.buyOrderId ===
                    buy100.id,
            );

        /*
         * The critical assertions.
         */

        assert(
            trade110 !== undefined,
            "Expected a trade against the 110 BUY",
        );

        assert(
            trade105 !== undefined,
            "Expected a trade against the 105 BUY",
        );

        assert(
            trade100 !== undefined,
            "Expected a trade against the 100 BUY",
        );

        assert(
            Number(trade110!.price) ===
                110,
            `Expected 110 BUY trade price 110, got ${trade110!.price}`,
        );

        assert(
            Number(trade110!.quantity) ===
                1,
            `Expected 110 BUY trade quantity 1, got ${trade110!.quantity}`,
        );

        assert(
            Number(trade105!.price) ===
                105,
            `Expected 105 BUY trade price 105, got ${trade105!.price}`,
        );

        assert(
            Number(trade105!.quantity) ===
                2,
            `Expected 105 BUY trade quantity 2, got ${trade105!.quantity}`,
        );

        assert(
            Number(trade100!.price) ===
                100,
            `Expected 100 BUY trade price 100, got ${trade100!.price}`,
        );

        assert(
            Number(trade100!.quantity) ===
                1,
            `Expected 100 BUY trade quantity 1, got ${trade100!.quantity}`,
        );

        /*
         * Verify final MARKET SELL state.
         */

        const sellAfter =
            await getOrder(
                marketSell.id,
            );

        assert(
            sellAfter.status ===
                "FILLED",
            `Expected MARKET SELL FILLED, got ${sellAfter.status}`,
        );

        assert(
            Number(
                sellAfter.remainingQty,
            ) === 0,
            "MARKET SELL should have 0 remaining quantity",
        );

        /*
         * Verify the three BUY orders.
         */

        const buy110After =
            await getOrder(
                buy110.id,
            );

        const buy105After =
            await getOrder(
                buy105.id,
            );

        const buy100After =
            await getOrder(
                buy100.id,
            );

        assert(
            buy110After.status ===
                "FILLED",
            "110 BUY should be FILLED",
        );

        assert(
            Number(
                buy110After.remainingQty,
            ) === 0,
            "110 BUY should have 0 remaining",
        );

        assert(
            buy105After.status ===
                "FILLED",
            "105 BUY should be FILLED",
        );

        assert(
            Number(
                buy105After.remainingQty,
            ) === 0,
            "105 BUY should have 0 remaining",
        );

        assert(
            buy100After.status ===
                "PARTIALLY_FILLED",
            "100 BUY should be PARTIALLY_FILLED",
        );

        assert(
            Number(
                buy100After.remainingQty,
            ) === 2,
            `100 BUY should have 2 BTC remaining, got ${buy100After.remainingQty}`,
        );

        console.log(
            "\nExpected matching:",
        );

        console.log(
            "110 × 1",
        );

        console.log(
            "105 × 2",
        );

        console.log(
            "100 × 1",
        );

        console.log(
            "\nFinal 100 BUY remaining:",
            buy100After.remainingQty.toString(),
        );

        console.log(
            "✅ MARKET SELL consumed highest bids first",
        );
    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

/* ============================================================
   TEST 4
   MARKET SELL larger than available liquidity.
   Remaining quantity should be cancelled.
   ============================================================ */

async function testMarketSellInsufficientLiquidity() {
    console.log(
        "\n========================================",
    );
    console.log(
        "TEST 4: MARKET SELL - INSUFFICIENT LIQUIDITY",
    );
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser(
            "market-sell-insufficient-seller",
        );

    const buyer =
        await createTestUser(
            "market-sell-insufficient-buyer",
        );

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

        const buy =
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "LIMIT",
                1,
                100,
            );

        const marketSell =
            await createOrderInDb(
                randomUUID(),
                seller.id,
                "SELL",
                "MARKET",
                2,
            );

        await matchSellOrder(
            marketSell.id,
        );

        const sellAfter =
            await getOrder(
                marketSell.id,
            );

        const buyAfter =
            await getOrder(
                buy.id,
            );

        const trades =
            await prisma.trade.findMany({
                where: {
                    sellOrderId:
                        marketSell.id,
                },
            });

        assert(
            trades.length === 1,
            `Expected 1 trade, got ${trades.length}`,
        );
        if(trades[0]===undefined){
            throw new Error("trades[0] undefined");
        }
        assert(
            Number(
                trades[0].quantity,
            ) === 1,
            `Expected 1 BTC traded, got ${trades[0].quantity}`,
        );

        assert(
            Number(
                trades[0].price,
            ) === 100,
            `Expected trade price 100, got ${trades[0].price}`,
        );

        assert(
            sellAfter.status ===
                "CANCELLED",
            `Expected MARKET SELL CANCELLED, got ${sellAfter.status}`,
        );

        assert(
            Number(
                sellAfter.remainingQty,
            ) === 1,
            `Expected 1 BTC remaining, got ${sellAfter.remainingQty}`,
        );

        assert(
            buyAfter.status ===
                "FILLED",
            `Expected BUY FILLED, got ${buyAfter.status}`,
        );

        console.log(
            "Executed quantity:",
            trades[0].quantity.toString(),
        );

        console.log(
            "Remaining MARKET SELL:",
            sellAfter.remainingQty.toString(),
        );

        console.log(
            "Final status:",
            sellAfter.status,
        );

        console.log(
            "✅ Insufficient MARKET SELL liquidity handled correctly",
        );
    } finally {
        await cleanupUsers([
            seller.id,
            buyer.id,
        ]);
    }
}

/* ============================================================
   TEST 5
   MARKET BUY with no liquidity should be rejected
   without locking funds.
   ============================================================ */

async function testMarketBuyNoLiquidity() {
    console.log(
        "\n========================================",
    );
    console.log(
        "TEST 5: MARKET BUY - NO LIQUIDITY",
    );
    console.log(
        "========================================",
    );

    const buyer =
        await createTestUser(
            "market-buy-no-liquidity",
        );

    try {
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

        let rejected = false;

        try {
            await createOrderInDb(
                randomUUID(),
                buyer.id,
                "BUY",
                "MARKET",
                1,
            );
        } catch (error) {
            rejected = true;

            console.log(
                "Order rejected:",
                error instanceof Error
                    ? error.message
                    : error,
            );
        }

        assert(
            rejected,
            "MARKET BUY with no liquidity should be rejected",
        );

        const balance =
            await prisma.balance.findUnique({
                where: {
                    userId_asset: {
                        userId: buyer.id,
                        asset: "USDT",
                    },
                },
            });

        if (!balance) {
            throw new Error(
                "USDT balance not found",
            );
        }

        assert(
            Number(balance.available) ===
                500,
            `Expected available USDT 500, got ${balance.available}`,
        );

        assert(
            Number(balance.locked) ===
                0,
            `Expected locked USDT 0, got ${balance.locked}`,
        );

        const orders =
            await prisma.order.findMany({
                where: {
                    userId: buyer.id,
                },
            });

        assert(
            orders.length === 0,
            `Expected 0 orders, got ${orders.length}`,
        );

        console.log(
            "Available USDT:",
            balance.available.toString(),
        );

        console.log(
            "Locked USDT:",
            balance.locked.toString(),
        );

        console.log(
            "Orders created:",
            orders.length,
        );

        console.log(
            "✅ No-liquidity MARKET BUY handled correctly",
        );
    } finally {
        await cleanupUsers([
            buyer.id,
        ]);
    }
}

/* ============================================================
   TEST 6
   MARKET SELL with no liquidity should be cancelled
   and BTC should be unlocked.
   ============================================================ */

async function testMarketSellNoLiquidity() {
    console.log(
        "\n========================================",
    );
    console.log(
        "TEST 6: MARKET SELL - NO LIQUIDITY",
    );
    console.log(
        "========================================",
    );

    const seller =
        await createTestUser(
            "market-sell-no-liquidity",
        );

    try {
        await createBalance(
            seller.id,
            "BTC",
            1,
        );

        await createBalance(
            seller.id,
            "USDT",
            0,
        );

        const marketSell =
            await createOrderInDb(
                randomUUID(),
                seller.id,
                "SELL",
                "MARKET",
                1,
            );

        await matchSellOrder(
            marketSell.id,
        );

        const sellAfter =
            await getOrder(
                marketSell.id,
            );

        assert(
            sellAfter.status ===
                "CANCELLED",
            `Expected MARKET SELL CANCELLED, got ${sellAfter.status}`,
        );

        const balance =
            await prisma.balance.findUnique({
                where: {
                    userId_asset: {
                        userId: seller.id,
                        asset: "BTC",
                    },
                },
            });

        if (!balance) {
            throw new Error(
                "BTC balance not found",
            );
        }

        assert(
            Number(balance.available) ===
                1,
            `Expected available BTC 1, got ${balance.available}`,
        );

        assert(
            Number(balance.locked) ===
                0,
            `Expected locked BTC 0, got ${balance.locked}`,
        );

        console.log(
            "Order status:",
            sellAfter.status,
        );

        console.log(
            "Available BTC:",
            balance.available.toString(),
        );

        console.log(
            "Locked BTC:",
            balance.locked.toString(),
        );

        console.log(
            "✅ No-liquidity MARKET SELL handled correctly",
        );
    } finally {
        await cleanupUsers([
            seller.id,
        ]);
    }
}

/* ============================================================
   MAIN
   ============================================================ */

async function main() {
    console.log(
        "========================================",
    );
    console.log(
        "   CEX V2 MARKET ORDER TESTS",
    );
    console.log(
        "========================================",
    );

    await testMarketBuyMultipleLevels();

    await testMarketBuyInsufficientLiquidity();

    await testMarketSellMultipleLevels();

    await testMarketSellInsufficientLiquidity();

    await testMarketBuyNoLiquidity();

    await testMarketSellNoLiquidity();

    console.log(
        "\n========================================",
    );
    console.log(
        "   ✅ ALL MARKET ORDER TESTS PASSED",
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
            "   ❌ MARKET ORDER TEST FAILED",
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