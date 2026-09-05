import { createOrderInDb, type OrderSide, type OrderType } from "./order.ts";
import {
    matchBuyOrder,
    matchSellOrder,
} from "./matching-engine.ts";
import { getOrderBookSnapshot } from "../backend/orderbook-snapshot";
import { publishDepthEvent } from "./redis-depth";
import { publishOrderStatusEvent } from "./redis-order-status";

export async function submitOrder(
    id: string,
    userId: string,
    side: OrderSide,
    type: OrderType,
    qty: number,
    price?: number,
) {
    const order = await createOrderInDb(
        id,
        userId,
        side,
        type,
        qty,
        price,
    );
    await publishOrderStatusEvent({
    type: "ORDER_STATUS",
    userId: order.userId,
    orderId: order.id,
    status: order.status,
    remainingQty: Number(order.remainingQty),
});
    let result;

    if (side === "BUY") {
        result = await matchBuyOrder(order.id);
    } else {
        result = await matchSellOrder(order.id);
    }

    const snapshot = await getOrderBookSnapshot(order.asset);

    await publishDepthEvent({
        type: "DEPTH",
        asset: order.asset,
        bids: snapshot.bids,
        asks: snapshot.asks,
    });

    return result;
}