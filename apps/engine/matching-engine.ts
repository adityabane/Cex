import { prisma } from "./db";
import {publishTradeEvent} from "./redis-market-data";
import { matchOrders } from "./matcher";
import { getBestAsk,getBestBid } from "./orderbook-db";
export async function matchBuyOrder(buyOrderId: string) {
    const buyOrder = await prisma.order.findUnique({
        where: {
            id: buyOrderId,
        },
    });

    if (!buyOrder) {
        throw new Error("Buy order not found");
    }

    if (buyOrder.side !== "BUY") {
        throw new Error("Order must be BUY");
    }

    while (true) {
        const currentBuy = await prisma.order.findUnique({
            where: {
                id: buyOrderId,
            },
        });
        if (!currentBuy) {
            throw new Error("Buy order not found");
        }
        // Nothing left to match
        if (
            currentBuy.remainingQty.lte(0) ||
            currentBuy.status === "FILLED"
        ) {
            break;
        }
        // Only LIMIT BUY for now
        if (currentBuy.price === null) {
            break;
        }
        const bestAsk = await getBestAsk("BTC");
        if (!bestAsk) {
            break;
        }
        if (bestAsk.price === null) {
            break;
        }
        // BUY price must be >= SELL price
        if (currentBuy.price.lt(bestAsk.price)) {
            break;
        }
        console.log(
            `Matching BUY ${currentBuy.id} with SELL ${bestAsk.id}`
        );
        const trade = await matchOrders(
            currentBuy.id,
            bestAsk.id
        );
        await publishTradeEvent({
            type:"TRADE",
            asset:currentBuy.asset,
            price:Number(trade.price),
            quantity:Number(trade.quantity),
        });
    }
    return prisma.order.findUnique({
        where: {
            id: buyOrderId,
        },
    });
}
export async function matchSellOrder(sellOrderId: string,createdAfter?:Date) {
    const sellOrder = await prisma.order.findUnique({
        where: {
            id: sellOrderId,
        },
    });

    if (!sellOrder) {
        throw new Error("Sell order not found");
    }

    if (sellOrder.side !== "SELL") {
        throw new Error("Order must be SELL");
    }

    while (true) {
        const currentSell = await prisma.order.findUnique({
            where: {
                id: sellOrderId,
            },
        });

        if (!currentSell) {
            throw new Error("Sell order not found");
        }

        if (
            currentSell.remainingQty.lte(0) ||
            currentSell.status === "FILLED"
        ) {
            break;
        }

        if (currentSell.price === null) {
            break;
        }

        const bestBid = await getBestBid("BTC",createdAfter);

        if (!bestBid) {
            break;
        }

        if (bestBid.price === null) {
            break;
        }

        // SELL price must be <= BUY price
        if (currentSell.price.gt(bestBid.price)) {
            break;
        }

        console.log(
            `Matching SELL ${currentSell.id} with BUY ${bestBid.id}`
        );

        const trade = await matchOrders(
            bestBid.id,
            currentSell.id
        );
        await publishTradeEvent({
            type: "TRADE",
            asset: currentSell.asset,
            price: Number(trade.price),
            quantity: Number(trade.quantity),
        });
    }

    return prisma.order.findUnique({
        where: {
            id: sellOrderId,
        },
    });
}