import { createOrderInDb, type OrderSide, type OrderType } from "./order.ts";
import {
    matchBuyOrder,
    matchSellOrder,
} from "./matching-engine.ts";

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

    if (side === "BUY") {
        return matchBuyOrder(order.id);
    }

    return matchSellOrder(order.id);
}