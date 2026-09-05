import { prisma } from "./db";
import { unlockBalance } from "./balance";

export async function cancelOrder(
    orderId: string,
    userId: string,
) {
    const order = await prisma.order.findUnique({
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

    const unlockAmount =
        order.side === "BUY"
            ? Number(order.remainingQty) * Number(order.price)
            : Number(order.remainingQty);

    const assetToUnlock =
        order.side === "BUY"
            ? "USDT"
            : "BTC";

    await unlockBalance(
        userId,
        assetToUnlock,
        unlockAmount,
    );

    return prisma.order.update({
        where: {
            id: orderId,
        },
        data: {
            status: "CANCELLED",
        },
    });
}