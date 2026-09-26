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
        if (sellOrder.price === null) {
            throw new Error("Sell order must have a price");
        }

        if (buyOrder.type === "LIMIT") {
            if (buyOrder.price === null) {
                throw new Error("Limit buy order must have a price");
            }

            if (buyOrder.price.lt(sellOrder.price)) {
                throw new Error("Orders cannot be matched");
            }
        }
        let quantity = buyOrder.remainingQty.lt(sellOrder.remainingQty)
            ? buyOrder.remainingQty
            : sellOrder.remainingQty;

        const tradePrice = sellOrder.price;

        if (buyOrder.type === "MARKET") {
            const buyerBalance = await tx.balance.findUnique({
                where: {
                    userId_asset: {
                        userId: buyOrder.userId,
                        asset: "USDT",
                    },
                },
            });

            if (!buyerBalance) {
                throw new Error("Buyer USDT balance not found");
            }

            const affordableQuantity = buyerBalance.locked.div(tradePrice);

            if (affordableQuantity.lte(0)) {
                throw new Error("Insufficient USDT for market order");
            }

            if (affordableQuantity.lt(quantity)) {
                quantity = affordableQuantity;
            }
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

        const reservedValue =
            buyOrder.type === "MARKET"
                ? tradeValue
                : quantity.mul(buyOrder.price!);

        const refund =
            buyOrder.type === "MARKET"
                ? 0
                : reservedValue.sub(tradeValue);

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
    },{
        maxWait:10000,
        timeout:15000,
    });
}