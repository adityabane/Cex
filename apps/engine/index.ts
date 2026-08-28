import { prisma } from "./db";
import { createUser } from "./user";
import { createBalance } from "./balance";
import { createOrderInDb } from "./order";
import { matchOrders } from "./matcher";
import { getBestAsk, getBestBid } from "./orderbook-db";
import { matchBuyOrder,matchSellOrder } from "./matching-engine";
import {submitOrder} from "./submit-order";
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
async function testCaseC() {
    console.log("\n==============================");
    console.log("TEST C2: TIME PRIORITY");
    console.log("==============================");
    const testStart = new Date();
    const buyer1 = await createUser();
    const buyer2 = await createUser();

    await createBalance(buyer1.id, "USDT", 10000);
    await createBalance(buyer2.id, "USDT", 10000);

    const order1 = await createOrderInDb(
        crypto.randomUUID(),
        buyer1.id,
        "BUY",
        "LIMIT",
        1,
        5000
    );

    // Small delay so createdAt is definitely different
    await new Promise((resolve) => setTimeout(resolve, 100));

    const order2 = await createOrderInDb(
        crypto.randomUUID(),
        buyer2.id,
        "BUY",
        "LIMIT",
        1,
        5000
    );

    console.log("\nORDER 1:");
    console.log(order1);

    console.log("\nORDER 2:");
    console.log(order2);

    const bestBid = await getBestBid("BTC",testStart);

    console.log("\nBEST BID:");
    console.log(bestBid);

    console.log("\nEXPECTED:");
    console.log("Best bid should be ORDER 1");

    console.log(
        "RESULT:",
        bestBid?.id === order1.id ? "PASS" : "FAIL"
    );
}
async function testCaseD() {
    console.log("\n==============================");
    console.log("TEST CASE D: MULTIPLE ORDERS");
    console.log("==============================");

    const buyer = await createUser();

    const seller1 = await createUser();
    const seller2 = await createUser();

    await createBalance(
        buyer.id,
        "USDT",
        10000
    );

    await createBalance(
        seller1.id,
        "BTC",
        0.3
    );

    await createBalance(
        seller2.id,
        "BTC",
        0.4
    );

    // --------------------------------
    // SELL 1
    // 0.3 BTC @ 4000
    // --------------------------------

    const sell1 = await createOrderInDb(
        crypto.randomUUID(),
        seller1.id,
        "SELL",
        "LIMIT",
        0.3,
        4000
    );

    // --------------------------------
    // SELL 2
    // 0.4 BTC @ 4500
    // --------------------------------

    const sell2 = await createOrderInDb(
        crypto.randomUUID(),
        seller2.id,
        "SELL",
        "LIMIT",
        0.4,
        4500
    );

    // --------------------------------
    // BUY
    // 0.5 BTC @ 5000
    // --------------------------------

    const buy = await createOrderInDb(
        crypto.randomUUID(),
        buyer.id,
        "BUY",
        "LIMIT",
        0.5,
        5000
    );

    console.log("\nSELL 1:", sell1);
    console.log("\nSELL 2:", sell2);
    console.log("\nBUY:", buy);

    // --------------------------------
    // MATCH
    // --------------------------------

    const finalBuy = await matchBuyOrder(buy.id);

    console.log("\nFINAL BUY:");
    console.log(finalBuy);

    // --------------------------------
    // FINAL SELL ORDERS
    // --------------------------------

    const finalSell1 = await prisma.order.findUnique({
        where: {
            id: sell1.id,
        },
    });

    const finalSell2 = await prisma.order.findUnique({
        where: {
            id: sell2.id,
        },
    });

    console.log("\nFINAL SELL 1:");
    console.log(finalSell1);

    console.log("\nFINAL SELL 2:");
    console.log(finalSell2);
}
async function testCaseE() {
    console.log("\n==============================");
    console.log("TEST CASE E: SELL SIDE MATCHING");
    console.log("==============================");
    const testStart = new Date();
    const buyer1 = await createUser();
    const buyer2 = await createUser();
    const seller = await createUser();

    // Buyer 1
    await createBalance(
        buyer1.id,
        "USDT",
        10000
    );

    // Buyer 2
    await createBalance(
        buyer2.id,
        "USDT",
        10000
    );

    // Seller
    await createBalance(
        seller.id,
        "BTC",
        0.5
    );

    // --------------------------------
    // BUY 1
    // 0.3 BTC @ 4000
    // --------------------------------

    const buy1 = await createOrderInDb(
        crypto.randomUUID(),
        buyer1.id,
        "BUY",
        "LIMIT",
        0.3,
        4000
    );

    // --------------------------------
    // BUY 2
    // 0.4 BTC @ 4500
    // --------------------------------

    const buy2 = await createOrderInDb(
        crypto.randomUUID(),
        buyer2.id,
        "BUY",
        "LIMIT",
        0.4,
        4500
    );

    // --------------------------------
    // SELL
    // 0.5 BTC @ 3500
    // --------------------------------

    const sell = await createOrderInDb(
        crypto.randomUUID(),
        seller.id,
        "SELL",
        "LIMIT",
        0.5,
        3500
    );

    console.log("\nBUY 1:");
    console.log(buy1);

    console.log("\nBUY 2:");
    console.log(buy2);

    console.log("\nSELL:");
    console.log(sell);

    // --------------------------------
    // MATCH SELL
    // --------------------------------

    const finalSell = await matchSellOrder(
        sell.id,testStart
    );

    console.log("\nFINAL SELL:");
    console.log(finalSell);

    // --------------------------------
    // FINAL ORDERS
    // --------------------------------

    const finalBuy1 = await prisma.order.findUnique({
        where: {
            id: buy1.id,
        },
    });

    const finalBuy2 = await prisma.order.findUnique({
        where: {
            id: buy2.id,
        },
    });

    console.log("\nFINAL BUY 1:");
    console.log(finalBuy1);

    console.log("\nFINAL BUY 2:");
    console.log(finalBuy2);
}
// =================================
// RUN TESTS
// =================================

async function main() {
    console.log("CEX V2 Engine Started");
    // await testCaseA();
    // await testCaseB();
    // await testCaseC();
    // await testCaseD();
    // await testCaseE();
    const buyer = await createUser();
const seller = await createUser();

await createBalance(buyer.id, "USDT", 5000);
await createBalance(seller.id, "BTC", 1);
const sell = await submitOrder(
    crypto.randomUUID(),
    seller.id,
    "SELL",
    "LIMIT",
    0.5,
    4000,
);

console.log("SELL:", sell);
const buy = await submitOrder(
    crypto.randomUUID(),
    buyer.id,
    "BUY",
    "LIMIT",
    0.5,
    4000,
);

console.log("BUY:", buy);

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