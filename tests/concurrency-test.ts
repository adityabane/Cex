import { randomUUID } from "crypto";
import { prisma } from "../apps/engine/db.ts";
import { createOrderInDb } from "../apps/engine/order.ts";
import { matchBuyOrder } from "../apps/engine/matching-engine.ts";

const TEST_PRICE = 100;

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
) {
    return prisma.user.create({
        data: {
            email: `${prefix}-${randomUUID()}@concurrency.test`,
            passwordHash: "test-password-hash",
        },
    });
}

async function createTestBalance(
    userId: string,
    asset: string,
    amount: number,
) {
    return prisma.balance.create({
        data: {
            userId,
            asset,
            available: amount,
            locked: 0,
        },
    });
}

async function main() {
    console.log("========================================");
    console.log("       CEX V2 CONCURRENCY TEST");
    console.log("========================================");

    /*
     * -------------------------------------
     * 1. CREATE USERS
     * -------------------------------------
     */

    console.log("\n1. Creating test users...");

    const seller = await createTestUser("seller");
    const buyerA = await createTestUser("buyer-a");
    const buyerB = await createTestUser("buyer-b");

    console.log("Seller:", seller.id);
    console.log("Buyer A:", buyerA.id);
    console.log("Buyer B:", buyerB.id);

    /*
     * -------------------------------------
     * 2. CREATE BALANCES
     * -------------------------------------
     *
     * Seller:
     *   1 BTC
     *
     * Buyer A:
     *   100 USDT
     *
     * Buyer B:
     *   100 USDT
     */

    console.log("\n2. Creating balances...");

    await createTestBalance(
        seller.id,
        "BTC",
        1,
    );

    await createTestBalance(
        seller.id,
        "USDT",
        0,
    );

    await createTestBalance(
        buyerA.id,
        "USDT",
        100,
    );

    await createTestBalance(
        buyerA.id,
        "BTC",
        0,
    );

    await createTestBalance(
        buyerB.id,
        "USDT",
        100,
    );

    await createTestBalance(
        buyerB.id,
        "BTC",
        0,
    );

    console.log("✅ Balances created");

    /*
     * -------------------------------------
     * 3. CREATE SELL ORDER
     * -------------------------------------
     *
     * Seller places:
     *
     * SELL 1 BTC @ 100 USDT
     *
     * This order provides exactly 1 BTC
     * of liquidity.
     */

    console.log("\n3. Creating SELL order...");

    const sellOrderId = randomUUID();

    const sellOrder = await createOrderInDb(
        sellOrderId,
        seller.id,
        "SELL",
        "LIMIT",
        1,
        TEST_PRICE,
    );

    console.log(
        "SELL order:",
        sellOrder.id,
    );

    /*
     * -------------------------------------
     * 4. CREATE TWO BUY ORDERS
     * -------------------------------------
     *
     * Buyer A:
     *   BUY 1 BTC @ 100
     *
     * Buyer B:
     *   BUY 1 BTC @ 100
     *
     * Both orders individually want the
     * entire 1 BTC SELL order.
     */

    console.log("\n4. Creating BUY orders...");

    const buyOrderAId = randomUUID();

    const buyOrderA = await createOrderInDb(
        buyOrderAId,
        buyerA.id,
        "BUY",
        "LIMIT",
        1,
        TEST_PRICE,
    );

    const buyOrderBId = randomUUID();

    const buyOrderB = await createOrderInDb(
        buyOrderBId,
        buyerB.id,
        "BUY",
        "LIMIT",
        1,
        TEST_PRICE,
    );

    console.log(
        "BUY A:",
        buyOrderA.id,
    );

    console.log(
        "BUY B:",
        buyOrderB.id,
    );

    /*
     * -------------------------------------
     * 5. RUN MATCHING CONCURRENTLY
     * -------------------------------------
     *
     * This is the important part.
     *
     * Both matching operations are started
     * at the same time.
     *
     * If there is a race condition, both
     * matchers may select the same SELL
     * order before either transaction updates
     * it.
     */

    console.log(
        "\n5. Running concurrent matching...",
    );

    const results = await Promise.allSettled([
        matchBuyOrder(buyOrderA.id),
        matchBuyOrder(buyOrderB.id),
    ]);

    console.log("\nConcurrent results:");

    for (const result of results) {
        if (result.status === "fulfilled") {
            console.log("✅ Matching operation completed");
        } else {
            console.log(
                "⚠️ Matching operation failed:",
                result.reason,
            );
        }
    }

    /*
     * -------------------------------------
     * 6. READ FINAL ORDERS
     * -------------------------------------
     */

    console.log("\n6. Reading final orders...");

    const finalSell = await prisma.order.findUnique({
        where: {
            id: sellOrder.id,
        },
    });

    const finalBuyA = await prisma.order.findUnique({
        where: {
            id: buyOrderA.id,
        },
    });

    const finalBuyB = await prisma.order.findUnique({
        where: {
            id: buyOrderB.id,
        },
    });

    console.log(
        "\nSELL:",
        JSON.stringify(finalSell, null, 2),
    );

    console.log(
        "\nBUY A:",
        JSON.stringify(finalBuyA, null, 2),
    );

    console.log(
        "\nBUY B:",
        JSON.stringify(finalBuyB, null, 2),
    );

    assert(
        !!finalSell,
        "SELL order disappeared",
    );

    assert(
        !!finalBuyA,
        "BUY A order disappeared",
    );

    assert(
        !!finalBuyB,
        "BUY B order disappeared",
    );

    /*
     * -------------------------------------
     * 7. CHECK NO NEGATIVE REMAINING QTY
     * -------------------------------------
     */

    console.log(
        "\n7. Checking remaining quantities...",
    );
    if(finalBuyA===null || finalSell===null || finalBuyB===null){
        throw new Error("Final buy A is null")
    }
    assert(
        Number(finalSell.remainingQty) >= 0,
        `SELL remaining quantity became negative: ${finalSell.remainingQty}`,
    );

    assert(
        Number(finalBuyA.remainingQty) >= 0,
        `BUY A remaining quantity became negative: ${finalBuyA.remainingQty}`,
    );

    assert(
        Number(finalBuyB.remainingQty) >= 0,
        `BUY B remaining quantity became negative: ${finalBuyB.remainingQty}`,
    );

    console.log(
        "✅ No order has negative remaining quantity",
    );

    /*
     * -------------------------------------
     * 8. CHECK TOTAL TRADE QUANTITY
     * -------------------------------------
     */

    console.log(
        "\n8. Checking total trade quantity...",
    );

    const trades = await prisma.trade.findMany({
        where: {
            OR: [
                {
                    sellOrderId: finalSell.id,
                },
                {
                    buyOrderId: finalBuyA.id,
                },
                {
                    buyOrderId: finalBuyB.id,
                },
            ],
        },
    });

    const totalTradeQuantity = trades.reduce(
        (total, trade) =>
            total + Number(trade.quantity),
        0,
    );

    console.log(
        "Trades:",
        trades.length,
    );

    console.log(
        "Total traded quantity:",
        totalTradeQuantity,
    );

    assert(
        totalTradeQuantity === 1,
        `Expected exactly 1 BTC traded, but ${totalTradeQuantity} BTC was traded`,
    );

    console.log(
        "✅ Exactly 1 BTC was traded",
    );

    /*
     * -------------------------------------
     * 9. CHECK SELLER BALANCE
     * -------------------------------------
     */

    console.log(
        "\n9. Checking seller balances...",
    );

    const sellerBTC = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: seller.id,
                asset: "BTC",
            },
        },
    });

    const sellerUSDT = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: seller.id,
                asset: "USDT",
            },
        },
    });

    assert(
        !!sellerBTC,
        "Seller BTC balance missing",
    );

    assert(
        !!sellerUSDT,
        "Seller USDT balance missing",
    );

    console.log(
        "Seller BTC:",
        sellerBTC,
    );

    console.log(
        "Seller USDT:",
        sellerUSDT,
    );
    if(sellerBTC===null || sellerUSDT===null){
        throw new Error("seller USdt is null")
    }
    assert(
        Number(sellerBTC.available) === 0,
        `Seller should have 0 BTC available, but has ${sellerBTC.available}`,
    );

    assert(
        Number(sellerBTC.locked) === 0,
        `Seller should have 0 BTC locked, but has ${sellerBTC.locked}`,
    );

    assert(
        Number(sellerUSDT.available) === 100,
        `Seller should receive 100 USDT, but has ${sellerUSDT.available}`,
    );

    assert(
        Number(sellerUSDT.locked) === 0,
        `Seller USDT should have 0 locked, but has ${sellerUSDT.locked}`,
    );

    console.log(
        "✅ Seller balance is correct",
    );

    /*
     * -------------------------------------
     * 10. CHECK BUYER BALANCES
     * -------------------------------------
     */

    console.log(
        "\n10. Checking buyer balances...",
    );

    const buyerABTC = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyerA.id,
                asset: "BTC",
            },
        },
    });

    const buyerAUSDT = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyerA.id,
                asset: "USDT",
            },
        },
    });

    const buyerBBTC = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyerB.id,
                asset: "BTC",
            },
        },
    });

    const buyerBUSDT = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyerB.id,
                asset: "USDT",
            },
        },
    });

    assert(
        !!buyerABTC &&
        !!buyerAUSDT &&
        !!buyerBBTC &&
        !!buyerBUSDT,
        "Buyer balances are missing",
    );

    console.log(
        "Buyer A BTC:",
        buyerABTC,
    );

    console.log(
        "Buyer A USDT:",
        buyerAUSDT,
    );

    console.log(
        "Buyer B BTC:",
        buyerBBTC,
    );

    console.log(
        "Buyer B USDT:",
        buyerBUSDT,
    );
    if(buyerABTC===null || buyerBBTC===null ||buyerAUSDT===null || buyerBUSDT===null){
        throw new Error("BuyerABTC is null");
    }
    const totalBuyerBTC =
        Number(buyerABTC.available) +
        Number(buyerBBTC.available);

    const totalBuyerUSDT =
    Number(buyerAUSDT.available) +
    Number(buyerAUSDT.locked) +
    Number(buyerBUSDT.available) +
    Number(buyerBUSDT.locked);

    assert(
        totalBuyerBTC === 1,
        `Buyers should receive exactly 1 BTC total, but received ${totalBuyerBTC}`,
    );

    assert(
        totalBuyerUSDT === 100,
        `Buyers should have exactly 100 USDT total remaining, but have ${totalBuyerUSDT}`,
    );

    assert(
        Number(buyerAUSDT.locked) >= 0,
        "Buyer A has negative locked USDT",
    );

    assert(
        Number(buyerBUSDT.locked) >= 0,
        "Buyer B has negative locked USDT",
    );

    console.log(
        "✅ Buyer balances are consistent",
    );

    /*
     * -------------------------------------
     * 11. FINAL ORDER CONSISTENCY
     * -------------------------------------
     */

    console.log(
        "\n11. Checking final order consistency...",
    );

    const filledBuyers = [
        finalBuyA,
        finalBuyB,
    ].filter(
        (order) =>
            order.status === "FILLED",
    );

    assert(
        filledBuyers.length === 1,
        `Exactly one BUY order should be FILLED, but ${filledBuyers.length} are FILLED`,
    );

    assert(
        finalSell.status === "FILLED",
        `SELL order should be FILLED, but status is ${finalSell.status}`,
    );

    const openBuyers = [
        finalBuyA,
        finalBuyB,
    ].filter(
        (order) =>
            order.status === "OPEN" ||
            order.status === "PARTIALLY_FILLED",
    );

    assert(
        openBuyers.length === 1,
        `Exactly one BUY order should remain open/partially filled, but ${openBuyers.length} remain`,
    );

    console.log(
        "✅ Final order states are consistent",
    );

    /*
     * -------------------------------------
     * 12. CLEANUP
     * -------------------------------------
     *
     * Delete only the data created by this
     * test.
     */

    console.log(
        "\n12. Cleaning up test data...",
    );

    await prisma.trade.deleteMany({
        where: {
            OR: [
                {
                    sellOrderId: sellOrder.id,
                },
                {
                    buyOrderId: buyOrderA.id,
                },
                {
                    buyOrderId: buyOrderB.id,
                },
            ],
        },
    });

    await prisma.order.deleteMany({
        where: {
            id: {
                in: [
                    sellOrder.id,
                    buyOrderA.id,
                    buyOrderB.id,
                ],
            },
        },
    });

    await prisma.balance.deleteMany({
        where: {
            userId: {
                in: [
                    seller.id,
                    buyerA.id,
                    buyerB.id,
                ],
            },
        },
    });

    await prisma.user.deleteMany({
        where: {
            id: {
                in: [
                    seller.id,
                    buyerA.id,
                    buyerB.id,
                ],
            },
        },
    });

    console.log("✅ Test data cleaned");

    /*
     * -------------------------------------
     * COMPLETE
     * -------------------------------------
     */

    console.log("\n========================================");
    console.log("   ✅ CONCURRENCY TEST PASSED");
    console.log("========================================");
}

main()
    .catch(async (error) => {
        console.error("\n========================================");
        console.error("   ❌ CONCURRENCY TEST FAILED");
        console.error("========================================");

        console.error(error);

        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });