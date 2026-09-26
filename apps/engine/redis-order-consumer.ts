import {redis} from "./redis";
import {submitOrder} from "./submit-order";
import { cancelOrder } from "./cancel-order";
import type {OrderSide,OrderType} from "./order";
import { getOrderBookSnapshot } from "../backend/orderbook-snapshot";
import { publishDepthEvent } from "./redis-depth";
import { publishOrderStatusEvent } from "./redis-order-status";
const ORDER_STREAM = "cex:orders";
const CONSUMER_GROUP = "cex-order-engine";
const CONSUMER_NAME = "engine-main";
type RedisMessage = [string,string[]];
type RedisStreamResult = [string,RedisMessage[]][];

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
async function setupConsumerGroup() {
    try {
        await redis.xgroup(
            "CREATE",
            ORDER_STREAM,
            CONSUMER_GROUP,
            "0",
            "MKSTREAM",
        );
        console.log(
            `Redis consumer group "${CONSUMER_GROUP}" created`,
        );
    } catch (error) {
        if (
            error instanceof Error &&
            error.message.includes("BUSYGROUP")
        ) {
            return;
        }
        throw error;
    }
}
async function processOrderMessage(
    messageId: string,
    fields: string[],
) {
    const order = parseFields(fields);
    console.log("Order received from Redis:");
    console.log(order);
    if (order.action === "CANCEL") {
        if (!order.orderId) {
            throw new Error(
                "Missing orderId in cancellation event",
            );
        }
        if (!order.userId) {
            throw new Error(
                "Missing userId in cancellation event",
            );
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
            remainingQty: Number(
                cancelledOrder.remainingQty,
            ),
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
            `Order ${order.orderId} cancelled`,
        );
    }else {
        if (!order.orderId) {
            throw new Error(
                "Missing orderId in Redis event",
            );
        }
        if (!order.userId) {
            throw new Error(
                "Missing userId in Redis event",
            );
        }
        if (!order.side) {
            throw new Error(
                "Missing side in Redis event",
            );
        }
        if (!order.type) {
            throw new Error(
                "Missing type in Redis event",
            );
        }
        if (!order.qty) {
            throw new Error(
                "Missing qty in Redis event",
            );
        }
        await submitOrder(
            order.orderId,
            order.userId,
            order.side as OrderSide,
            order.type as OrderType,
            Number(order.qty),
            order.price !== undefined
                ? Number(order.price)
                : undefined,
        );
        console.log(
            `Order ${order.orderId} processed`,
        );
    }
    await redis.xack(
        ORDER_STREAM,
        CONSUMER_GROUP,
        messageId,
    );
    console.log(
        `Redis message ${messageId} acknowledged`,
    );
}
async function readMessages(
    messageId: "0" | ">",
) {
    return await redis.xreadgroup(
        "GROUP",
        CONSUMER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        10,
        "STREAMS",
        ORDER_STREAM,
        messageId,
    ) as RedisStreamResult | null;
}
async function consumeOrders() {
    await setupConsumerGroup();

    console.log(
        `Redis order consumer started as "${CONSUMER_NAME}"`,
    );

    while (true) {
        try {
            const pending = await readMessages("0");
            if (pending && pending.some(([, messages]) => messages.length > 0)) {
                for (const [_streamName, messages] of pending) {
                    for (const [messageId, fields] of messages) {
                        await processOrderMessage(
                            messageId,
                            fields,
                        );
                    }
                }

                continue;
            }

            /*
             * STEP 2
             *
             * No pending messages.
             * Now read new messages.
             */
            const result = await readMessages(">");

            if (result) {
                for (const [_streamName, messages] of result) {
                    for (const [messageId, fields] of messages) {
                        await processOrderMessage(
                            messageId,
                            fields,
                        );
                    }
                }
            }

            await new Promise((resolve) =>
                setTimeout(resolve, 1000),
            );
        } catch (error) {
            console.error(
                "Redis consumer error:",
                error,
            );

            /*
             * IMPORTANT:
             *
             * We do NOT ACK the failed message.
             *
             * Therefore Redis keeps it in the
             * consumer group's pending entries.
             */
            await new Promise((resolve) =>
                setTimeout(resolve, 2000),
            );
        }
    }
}

consumeOrders();
