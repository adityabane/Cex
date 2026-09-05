import {prisma} from "./db";
export async function matchOrders(buyOrderId:string,sellOrderId:string){
    return prisma.$transaction(async(tx)=>{
        const buyOrder = await tx.order.findUnique({
            where:{
                id:buyOrderId,
            },
        });
        const sellOrder = await tx.order.findUnique({
            where:{
                id:sellOrderId,
            },
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
        if (
            (buyOrder.status !== "OPEN" &&
                buyOrder.status !== "PARTIALLY_FILLED") ||
            (sellOrder.status !== "OPEN" &&
                sellOrder.status !== "PARTIALLY_FILLED")
        ) {
            throw new Error("Orders must be OPEN or PARTIALLY_FILLED");
        }
        if (
            buyOrder.price === null ||
            sellOrder.price === null
        ) {
            throw new Error("Both orders must have a price");
        }
        if (buyOrder.price.lt(sellOrder.price)) {
            throw new Error("Orders cannot be matched");
        }
        const quantity = buyOrder.remainingQty.lt(sellOrder.remainingQty)?buyOrder.remainingQty:sellOrder.remainingQty;
        const tradePrice = sellOrder.price;
        const trade = await tx.trade.create({
            data:{
                buyOrderId:buyOrder.id,
                sellOrderId:sellOrder.id,
                price:tradePrice,
                quantity,
            },
        });
         await tx.order.update({
            where: {
                id: buyOrder.id,
            },
            data: {
                remainingQty: {
                    decrement: quantity,
                },
                status:
                    buyOrder.remainingQty.equals(quantity)
                        ? "FILLED"
                        : "PARTIALLY_FILLED",
            },
        });

        await tx.order.update({
            where: {
                id: sellOrder.id,
            },
            data: {
                remainingQty: {
                    decrement: quantity,
                },
                status:
                    sellOrder.remainingQty.equals(quantity)
                        ? "FILLED"
                        : "PARTIALLY_FILLED",
            },
        });
        const tradeValue = quantity.mul(tradePrice);
        const reservedValue = quantity.mul(buyOrder.price);
        const refund = reservedValue.sub(tradeValue);
        await tx.balance.update({
            where:{
                userId_asset:{
                    userId:buyOrder.userId,
                    asset:"USDT",
                },
            },
            data:{
                locked:{
                    decrement:reservedValue,
                },
                available: {
                    increment: refund,
                },
            },
        });
        await tx.balance.upsert({
            where: {
                userId_asset: {
                    userId: buyOrder.userId,
                    asset: buyOrder.asset,
                },
            },
            create: {
                userId: buyOrder.userId,
                asset: buyOrder.asset,
                available: quantity,
                locked: 0,
            },
            update: {
                available: {
                    increment: quantity,
                },
            },
        });
        await tx.balance.update({
            where: {
                userId_asset: {
                    userId: sellOrder.userId,
                    asset: sellOrder.asset,
                },
            },
            data: {
                locked: {
                    decrement: quantity,
                },
            },
        });
        await tx.balance.upsert({
            where: {
                userId_asset: {
                    userId: sellOrder.userId,
                    asset: "USDT",
                },
            },
            create: {
                userId: sellOrder.userId,
                asset: "USDT",
                available: tradeValue,
                locked: 0,
            },
            update: {
                available: {
                    increment: tradeValue,
                },
            },
        });
        return trade;
    });
}