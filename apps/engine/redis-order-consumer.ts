import {redis} from "./redis";
import {submitOrder} from "./submit-order";
import { cancelOrder } from "./cancel-order";
import type {OrderSide,OrderType} from "./order";
import { getOrderBookSnapshot } from "../backend/orderbook-snapshot";
import { publishDepthEvent } from "./redis-depth";
import { publishOrderStatusEvent } from "./redis-order-status";
const ORDER_STREAM = "cex:orders";
type RedisMessage = [
    string,string[]
];
type RedisStreamResult = [
    string,RedisMessage[]
][];
let lastId = "0-0";

function parseFields(fields:string[]){
    const data: Record<string,string> = {};
    for(let i=0;i< fields.length;i += 2){
        const key = fields[i];
        const value = fields[i+1];
        if(key ===undefined || value===undefined){
            continue;
        }
        data[key] = value;
    }
    return data;
}

async function consumeOrders(){
    console.log("Redis order consumer started...");
    while(true){
        try{
            const result = await redis.xread(ORDER_STREAM,lastId) as RedisStreamResult | null;
            if(result){
                for (const [_streamName,messages] of result){
                    for(const [messageId,fields] of messages){
                        lastId = messageId;
                        const order = parseFields(fields);
                        console.log("Order received from Redis:");
                        console.log(order);
                        if (order.action === "CANCEL") {
                            if (!order.orderId) {
                                throw new Error("Missing orderId in cancellation event");
                            }

                            if (!order.userId) {
                                throw new Error("Missing userId in cancellation event");
                            }

                            const cancelledOrder = await cancelOrder(
                                order.orderId,
                                order.userId,
                            );
                            await publishOrderStatusEvent({
                                type: "ORDER_STATUS",
                                userId: cancelledOrder.userId,
                                orderId: cancelledOrder.id,
                                status: cancelledOrder.status,
                                remainingQty: Number(cancelledOrder.remainingQty),
                            });

                            const snapshot = await getOrderBookSnapshot(
                                cancelledOrder.asset,
                            );

                            await publishDepthEvent({
                                type: "DEPTH",
                                asset: cancelledOrder.asset,
                                bids: snapshot.bids,
                                asks: snapshot.asks,
                            });

                            console.log(
                                `Order ${order.orderId} cancelled`
                            );

                            continue;
                        }
                        if (!order.orderId) {
                            throw new Error("Missing orderId in Redis event");
                        }

                        if (!order.userId) {
                            throw new Error("Missing userId in Redis event");
                        }

                        if (!order.side) {
                            throw new Error("Missing side in Redis event");
                        }

                        if (!order.type) {
                            throw new Error("Missing type in Redis event");
                        }

                        if (!order.qty) {
                            throw new Error("Missing qty in Redis event");
                        }
                        await submitOrder(
                            order.orderId,
                            order.userId,
                            order.side as OrderSide,
                            order.type as OrderType,
                            Number(order.qty),
                            order.price !== undefined
                                ? Number(order.price)
                                : undefined
                        );

                        console.log(
                            `Order ${order.orderId} processed`
                        );
                    }
                }
            }
            await new Promise((resolve)=>setTimeout(resolve,1000));

        }catch(error){
            console.error("Redis consumer error:",error);
            await new Promise((resolve)=>setTimeout(resolve,2000));
        }
    }
}
consumeOrders()