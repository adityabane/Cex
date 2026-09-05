import { redis } from "./redis";

const MARKET_DATA_STREAM = "cex:market-data";

export type OrderStatusEvent = {
    type: "ORDER_STATUS";
    userId: string;
    orderId: string;
    status: string;
    remainingQty: number;
};

export async function publishOrderStatusEvent(
    event: OrderStatusEvent,
) {
    return redis.xadd(
        MARKET_DATA_STREAM,
        "*",
        {
            type: event.type,
            userId: event.userId,
            orderId: event.orderId,
            status: event.status,
            remainingQty: event.remainingQty.toString(),
        },
    );
}