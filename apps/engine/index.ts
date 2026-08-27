import { prisma } from "./db";
import { createUser } from "./user";
import { createBalance } from "./balance";
import { createOrderInDb } from "./order";
import { matchOrders } from "./matcher";

async function testCaseA() {
    console.log("\n==============================");
    console.log("TEST CASE A: SAME PRICE");
    console.log("==============================");

    // -------------------------
    // Create Buyer
    // -------------------------

    const buyer = await createUser();

    await createBalance(
        buyer.id,
        "USDT",
        10000
    );

    // -------------------------
    // Create Seller
    // -------------------------

    const seller = await createUser();

    await createBalance(
        seller.id,
        "BTC",
        1
    );

    // -------------------------
    // BUY 1 BTC @ 5000
    // -------------------------

    const buyOrder = await createOrderInDb(
        crypto.randomUUID(),
        buyer.id,
        "BUY",
        "LIMIT",
        1,
        5000
    );

    // -------------------------
    // SELL 0.3 BTC @ 5000
    // -------------------------

    const sellOrder = await createOrderInDb(
        crypto.randomUUID(),
        seller.id,
        "SELL",
        "LIMIT",
        0.3,
        5000
    );

    console.log("BUY Order:", buyOrder);
    console.log("SELL Order:", sellOrder);

    // -------------------------
    // MATCH
    // -------------------------

    const trade = await matchOrders(
        buyOrder.id,
        sellOrder.id
    );

    console.log("Trade:", trade);

    // -------------------------
    // FINAL ORDERS
    // -------------------------

    const finalBuy = await prisma.order.findUnique({
        where: {
            id: buyOrder.id,
        },
    });

    const finalSell = await prisma.order.findUnique({
        where: {
            id: sellOrder.id,
        },
    });

    // -------------------------
    // FINAL BALANCES
    // -------------------------

    const buyerUSDT = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyer.id,
                asset: "USDT",
            },
        },
    });

    const buyerBTC = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyer.id,
                asset: "BTC",
            },
        },
    });

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

    console.log("\nFinal BUY:", finalBuy);
    console.log("Final SELL:", finalSell);

    console.log("\nBuyer USDT:", buyerUSDT);
    console.log("Buyer BTC:", buyerBTC);

    console.log("\nSeller BTC:", sellerBTC);
    console.log("Seller USDT:", sellerUSDT);
}


async function testCaseB() {
    console.log("\n==============================");
    console.log("TEST CASE B: PRICE IMPROVEMENT");
    console.log("==============================");

    // -------------------------
    // Create Buyer
    // -------------------------

    const buyer = await createUser();

    await createBalance(
        buyer.id,
        "USDT",
        10000
    );

    // -------------------------
    // Create Seller
    // -------------------------

    const seller = await createUser();

    await createBalance(
        seller.id,
        "BTC",
        1
    );

    // -------------------------
    // BUY 1 BTC @ 5000
    // -------------------------

    const buyOrder = await createOrderInDb(
        crypto.randomUUID(),
        buyer.id,
        "BUY",
        "LIMIT",
        1,
        5000
    );

    // -------------------------
    // SELL 0.3 BTC @ 4000
    // -------------------------

    const sellOrder = await createOrderInDb(
        crypto.randomUUID(),
        seller.id,
        "SELL",
        "LIMIT",
        0.3,
        4000
    );

    console.log("BUY Order:", buyOrder);
    console.log("SELL Order:", sellOrder);

    // -------------------------
    // MATCH
    // -------------------------

    const trade = await matchOrders(
        buyOrder.id,
        sellOrder.id
    );

    console.log("Trade:", trade);

    // -------------------------
    // FINAL ORDERS
    // -------------------------

    const finalBuy = await prisma.order.findUnique({
        where: {
            id: buyOrder.id,
        },
    });

    const finalSell = await prisma.order.findUnique({
        where: {
            id: sellOrder.id,
        },
    });

    // -------------------------
    // FINAL BALANCES
    // -------------------------

    const buyerUSDT = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyer.id,
                asset: "USDT",
            },
        },
    });

    const buyerBTC = await prisma.balance.findUnique({
        where: {
            userId_asset: {
                userId: buyer.id,
                asset: "BTC",
            },
        },
    });

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

    console.log("\nFinal BUY:", finalBuy);
    console.log("Final SELL:", finalSell);

    console.log("\nBuyer USDT:", buyerUSDT);
    console.log("Buyer BTC:", buyerBTC);

    console.log("\nSeller BTC:", sellerBTC);
    console.log("Seller USDT:", sellerUSDT);
}


// =================================
// RUN TESTS
// =================================

async function main() {
    console.log("CEX V2 Engine Started");

    await testCaseA();

    await testCaseB();

    console.log("\n==============================");
    console.log("ALL TESTS COMPLETED");
    console.log("==============================");
}

main()
    .catch((error) => {
        console.error("\nTEST FAILED:");
        console.error(error);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });