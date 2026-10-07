import { redis } from "./redis";

const ORDER_STREAM = "cex:orders";

export type OrderEvent = {
    orderId: string;
    userId :string;
    asset:string;
    side:string;
    type:string;
    qty:number;
    price?:number;
};

export async function publishOrder(order: OrderEvent) {
    return redis.xadd(
        ORDER_STREAM,
        "*",
        "orderId",
        order.orderId,
        "userId",
        order.userId,
        "asset",
        order.asset,
        "side",
        order.side,
        "type",
        order.type,
        "qty",
        order.qty.toString(),
        ...(order.price !== undefined
            ? ["price", order.price.toString()]
            : []),
    );
}