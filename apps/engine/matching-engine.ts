import { prisma } from "./db";
import {publishTradeEvent} from "./redis-market-data";
import { matchOrders } from "./matcher";
import { getBestAsk,getBestBid } from "./orderbook-db";
import { publishOrderStatusEvent } from "./redis-order-status";
import { unlockBalance } from "./balance";
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
        const bestAsk = await getBestAsk("BTC");

        if (!bestAsk) {
            break;
        }

        if (bestAsk.price === null) {
            break;
        }

        if (currentBuy.type === "LIMIT") {
            if (currentBuy.price === null) {
                break;
            }

            // LIMIT BUY price must be >= SELL price
            if (currentBuy.price.lt(bestAsk.price)) {
                break;
            }
        }
        console.log(
            `Matching BUY ${currentBuy.id} with SELL ${bestAsk.id}`
        );
        const trade = await matchOrders(
            currentBuy.id,
            bestAsk.id
        );
        const updatedBuyOrder = await prisma.order.findUnique({
            where: { id: currentBuy.id },
        });

        const updatedSellOrder = await prisma.order.findUnique({
            where: { id: bestAsk.id },
        });

        if (updatedBuyOrder) {
            await publishOrderStatusEvent({
                type: "ORDER_STATUS",
                userId: updatedBuyOrder.userId,
                orderId: updatedBuyOrder.id,
                status: updatedBuyOrder.status,
                remainingQty: Number(updatedBuyOrder.remainingQty),
            });
        }

        if (updatedSellOrder) {
            await publishOrderStatusEvent({
                type: "ORDER_STATUS",
                userId: updatedSellOrder.userId,
                orderId: updatedSellOrder.id,
                status: updatedSellOrder.status,
                remainingQty: Number(updatedSellOrder.remainingQty),
            });
        }
        await publishTradeEvent({
            type:"TRADE",
            asset:currentBuy.asset,
            price:Number(trade.price),
            quantity:Number(trade.quantity),
        });
    }
        if (buyOrder.type === "MARKET") {
        const finalBuy = await prisma.order.findUnique({
            where: {
                id: buyOrderId,
            },
        });

        if (!finalBuy) {
            throw new Error("Buy order not found");
        }

        if (finalBuy.remainingQty.gt(0)) {
            await prisma.order.update({
                where: {
                    id: finalBuy.id,
                },
                data: {
                    status: "CANCELLED",
                },
            });
        }

        const balance = await prisma.balance.findUnique({
            where: {
                userId_asset: {
                    userId: finalBuy.userId,
                    asset: "USDT",
                },
            },
        });

        if (balance && balance.locked.gt(0)) {
            await unlockBalance(
                finalBuy.userId,
                "USDT",
                Number(balance.locked),
            );
        }
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

        const updatedBuyOrder = await prisma.order.findUnique({
            where: { id: bestBid.id },
        });

        const updatedSellOrder = await prisma.order.findUnique({
            where: { id: currentSell.id },
        });

        if (updatedBuyOrder) {
            await publishOrderStatusEvent({
                type: "ORDER_STATUS",
                userId: updatedBuyOrder.userId,
                orderId: updatedBuyOrder.id,
                status: updatedBuyOrder.status,
                remainingQty: Number(updatedBuyOrder.remainingQty),
            });
        }

        if (updatedSellOrder) {
            await publishOrderStatusEvent({
                type: "ORDER_STATUS",
                userId: updatedSellOrder.userId,
                orderId: updatedSellOrder.id,
                status: updatedSellOrder.status,
                remainingQty: Number(updatedSellOrder.remainingQty),
            });
        }
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