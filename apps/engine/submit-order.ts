import { createOrderInDb, type OrderSide, type OrderType } from "./order.ts";
import {
    matchBuyOrder,
    matchSellOrder,
} from "./matching-engine.ts";
import { scheduleDepthUpdate } from "./depth-update-scheduler";
import { publishOrderStatusEvent } from "./redis-order-status";
import { measureDbOperation } from "./metrics";
export async function submitOrder(
    id: string,
    userId: string,
    asset:string,
    side: OrderSide,
    type: OrderType,
    qty: number,
    price?: number,
) {
    const order = await measureDbOperation(()=>createOrderInDb(
        id,
        userId,
        asset,
        side,
        type,
        qty,
        price,
    ));
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

    scheduleDepthUpdate(order.asset);

    return result;
}