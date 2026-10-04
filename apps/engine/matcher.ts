import {prisma} from "./db";

export async function matchOrders(buyOrderId:string,sellOrderId:string){
    return prisma.$transaction(async(tx)=>{

        // Lock both orders in a deterministic order to prevent
        // concurrent transactions from matching the same orders.
        const orderIds = [buyOrderId, sellOrderId].sort();

        for (const orderId of orderIds) {
            await tx.$queryRaw`
                SELECT "id"
                FROM "Order"
                WHERE "id" = ${orderId}
                FOR UPDATE
            `;
        }

        // Read the orders only after acquiring the row locks.
        const buyOrder = await tx.order.findUnique({
            where:{id:buyOrderId}
        });

        const sellOrder = await tx.order.findUnique({
            where:{id:sellOrderId}
        });

        if (!buyOrder || !sellOrder) {
            throw new Error("Order not found");
        }

        if (buyOrder.side !== "BUY") {
            throw new Error("First order must be BUY");
        }

        if (sellOrder.side !== "SELL") {
            throw new Error("Second order must be SELL");
        }

        if (buyOrder.asset !== sellOrder.asset) {
            throw new Error("Assets do not match");
        }

        // Another concurrent matcher may have already filled
        // one of these orders while this transaction was waiting
        // for the row lock.
        if (
            (buyOrder.status !== "OPEN" &&
                buyOrder.status !== "PARTIALLY_FILLED") ||
            (sellOrder.status !== "OPEN" &&
                sellOrder.status !== "PARTIALLY_FILLED")
        ) {
            return null;
        }

        if (
            sellOrder.type === "LIMIT" &&
            sellOrder.price === null
        ) {
            throw new Error("Limit Sell order must have a price");
        }

        if (buyOrder.type === "LIMIT") {

            if (buyOrder.price === null) {
                throw new Error("Limit buy order must have a price");
            }

            if (
                sellOrder.type === "LIMIT" &&
                sellOrder.price !== null &&
                buyOrder.price.lt(sellOrder.price)
            ) {
                throw new Error("Orders cannot be matched");
            }
        }

        const quantity =
            buyOrder.remainingQty.lt(sellOrder.remainingQty)
                ? buyOrder.remainingQty
                : sellOrder.remainingQty;

        const tradePrice =
            sellOrder.type === "MARKET"
                ? buyOrder.price
                : sellOrder.price;

        if (tradePrice === null) {
            throw new Error("Trade price not available");
        }

        const trade = await tx.trade.create({
            data:{
                buyOrderId:buyOrder.id,
                sellOrderId:sellOrder.id,
                price:tradePrice,
                quantity,
            },
        });

        await tx.order.update({
            where:{id:buyOrder.id},
            data:{
                remainingQty:{decrement:quantity},
                status:
                    buyOrder.remainingQty.equals(quantity)
                        ? "FILLED"
                        : "PARTIALLY_FILLED",
            },
        });

        await tx.order.update({
            where:{id:sellOrder.id},
            data:{
                remainingQty:{decrement:quantity},
                status:
                    sellOrder.remainingQty.equals(quantity)
                        ? "FILLED"
                        : "PARTIALLY_FILLED",
            },
        });

        const tradeValue = quantity.mul(tradePrice);

        // MARKET BUY reservation handling
        if (buyOrder.type === "MARKET") {

            if (buyOrder.marketBuyReservedUSDT === null) {
                throw new Error("Market BUY has no reserved USDT");
            }

            if (buyOrder.marketBuyReservedUSDT.lt(tradeValue)) {
                throw new Error("Market BUY reservation exceeded");
            }

            await tx.order.update({
                where:{id:buyOrder.id},
                data:{
                    marketBuyReservedUSDT:{
                        decrement:tradeValue
                    }
                },
            });
        }

        const reservedValue =
            buyOrder.type === "MARKET"
                ? tradeValue
                : quantity.mul(buyOrder.price!);

        const refund =
            buyOrder.type === "MARKET"
                ? 0
                : reservedValue.sub(tradeValue);

        // Deduct USDT from buyer's locked balance
        // and refund unused LIMIT BUY reservation.
        await tx.balance.update({
            where:{
                userId_asset:{
                    userId:buyOrder.userId,
                    asset:"USDT"
                }
            },
            data:{
                locked:{decrement:reservedValue},
                available:{increment:refund},
            },
        });

        // Credit purchased asset to buyer.
        await tx.balance.upsert({
            where:{
                userId_asset:{
                    userId:buyOrder.userId,
                    asset:buyOrder.asset
                }
            },
            create:{
                userId:buyOrder.userId,
                asset:buyOrder.asset,
                available:quantity,
                locked:0,
            },
            update:{
                available:{increment:quantity}
            },
        });

        // Deduct sold asset from seller's locked balance.
        await tx.balance.update({
            where:{
                userId_asset:{
                    userId:sellOrder.userId,
                    asset:sellOrder.asset
                }
            },
            data:{
                locked:{decrement:quantity}
            },
        });

        // Credit USDT to seller.
        await tx.balance.upsert({
            where:{
                userId_asset:{
                    userId:sellOrder.userId,
                    asset:"USDT"
                }
            },
            create:{
                userId:sellOrder.userId,
                asset:"USDT",
                available:tradeValue,
                locked:0,
            },
            update:{
                available:{increment:tradeValue}
            },
        });

        return trade;

    },{
        maxWait:10000,
        timeout:15000,
    });
}