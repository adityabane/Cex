
import { prisma } from "./db";

export async function cancelOrder(
    orderId: string,
    userId: string,
) {
    return prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
            where: {
                id: orderId,
            },
        });

        if (!order) {
            throw new Error("Order not found");
        }

        if (order.userId !== userId) {
            throw new Error("You cannot cancel this order");
        }

        if (
            order.status !== "OPEN" &&
            order.status !== "PARTIALLY_FILLED"
        ) {
            throw new Error("Order cannot be cancelled");
        }

        if (order.remainingQty.lte(0)) {
            throw new Error("Order has no remaining quantity");
        }

        let assetToUnlock: string;
        let unlockAmount;

        if (
            order.type === "MARKET" &&
            order.side === "BUY"
        ) {
            if (
                order.marketBuyReservedUSDT === null ||
                order.marketBuyReservedUSDT.lte(0)
            ) {
                throw new Error(
                    "Market BUY has no reserved USDT",
                );
            }

            assetToUnlock = "USDT";
            unlockAmount = order.marketBuyReservedUSDT;
        } else if (order.side === "BUY") {
            if (order.price === null) {
                throw new Error(
                    "LIMIT BUY order has no price",
                );
            }

            assetToUnlock = "USDT";
            unlockAmount = order.remainingQty.mul(order.price);
        } else {
            assetToUnlock = order.asset;
            unlockAmount = order.remainingQty;
        }

        // Only one concurrent cancellation can claim this order.
        const claimed = await tx.order.updateMany({
            where: {
                id: order.id,
                userId,
                status: order.status,
                remainingQty: order.remainingQty,
            },
            data: {
                status: "CANCELLED",
                marketBuyReservedUSDT: null,
            },
        });

        if (claimed.count !== 1) {
            throw new Error(
                "Order changed before cancellation; retry if appropriate",
            );
        }

        const balance = await tx.balance.findUnique({
            where: {
                userId_asset: {
                    userId,
                    asset: assetToUnlock,
                },
            },
        });

        if (!balance) {
            throw new Error(
                `Balance not found for ${assetToUnlock}`,
            );
        }

        if (balance.locked.lt(unlockAmount)) {
            throw new Error(
                `Insufficient locked ${assetToUnlock} balance`,
            );
        }

        await tx.balance.update({
            where: {
                userId_asset: {
                    userId,
                    asset: assetToUnlock,
                },
            },
            data: {
                locked: {
                    decrement: unlockAmount,
                },
                available: {
                    increment: unlockAmount,
                },
            },
        });

        const cancelledOrder = await tx.order.findUnique({
            where: {
                id: orderId,
            },
        });

        if (!cancelledOrder) {
            throw new Error(
                "Cancelled order could not be retrieved",
            );
        }

        return cancelledOrder;
    });
}
