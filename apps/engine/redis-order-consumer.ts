import {redis} from "./redis";
import {submitOrder} from "./submit-order";
import {cancelOrder} from "./cancel-order";
import type {OrderSide,OrderType} from "./order";
import {getOrderBookSnapshot} from "../backend/orderbook-snapshot";
import {publishDepthEvent} from "./redis-depth";
import {publishOrderStatusEvent} from "./redis-order-status";
import { recordOrderFailed, recordOrderProcessed } from "./metrics";

const ORDER_STREAM = "cex:orders";
const CONSUMER_GROUP = "cex-order-engine";
const CONSUMER_NAME = "engine-main";

/*
 * A pending message must be idle for this amount of time
 * before another consumer is allowed to recover it.
 *
 * 5000 ms = 5 seconds.
 */
const PENDING_MESSAGE_IDLE_TIME = 5000;

type RedisMessage = [
    string,
    string[],
];

type RedisStreamResult = [
    string,
    RedisMessage[],
][];

type PendingMessage = [
    string,
    string,
    number,
    string,
];

type ClaimedMessage = [
    string,
    string[],
];

function parseFields(
    fields: string[],
): Record<string,string> {
    const data: Record<string,string> = {};

    for (
        let i = 0;
        i < fields.length;
        i += 2
    ) {
        const key = fields[i];
        const value = fields[i + 1];

        if (
            key === undefined ||
            value === undefined
        ) {
            continue;
        }

        data[key] = value;
    }

    return data;
}

async function setupConsumerGroup(): Promise<void> {
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
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            error.message.includes("BUSYGROUP")
        ) {
            return;
        }

        throw error;
    }
}

async function processOrderMessageInternal(
    messageId: string,
    fields: string[],
): Promise<void> {
    const order =
        parseFields(fields);

    // console.log(
    //     "Order received from Redis:",
    // );

    // console.log(order);

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

        const cancelledOrder =
            await cancelOrder(
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

        const snapshot =
            await getOrderBookSnapshot(
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
    } else {
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
        if (!order.asset) {
            throw new Error(
                "Missing asset in Redis event",
            );
        }

        const asset =
            order.asset.trim().toUpperCase();

        await submitOrder(
            order.orderId,
            order.userId,
            asset,
            order.side as OrderSide,
            order.type as OrderType,
            Number(order.qty),
            order.price !== undefined
                ? Number(order.price)
                : undefined,
        );

        // console.log(
        //     `Order ${order.orderId} processed`,
        // );
    }

    await redis.xack(
        ORDER_STREAM,
        CONSUMER_GROUP,
        messageId,
    );

    // console.log(
    //     `Redis message ${messageId} acknowledged`,
    // );
}
async function processOrderMessage(messageId: string, fields: string[]): Promise<void> {
    const startedAt = performance.now();
    try {
        await processOrderMessageInternal(messageId, fields);
        recordOrderProcessed(performance.now() - startedAt);
    } catch (error) {
        recordOrderFailed();
        throw error;
    }
}

async function readMessages(
    messageId: "0" | ">",
): Promise<RedisStreamResult | null> {
    if (messageId === ">") {
        return await redis.xreadgroup(
            "GROUP",
            CONSUMER_GROUP,
            CONSUMER_NAME,
            "COUNT",
            100,
            "BLOCK",
            1000,
            "STREAMS",
            ORDER_STREAM,
            messageId,
        ) as RedisStreamResult | null;
    }

    return await redis.xreadgroup(
        "GROUP",
        CONSUMER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        100,
        "STREAMS",
        ORDER_STREAM,
        messageId,
    ) as RedisStreamResult | null;
}
/*
 * Recover pending messages that have been idle
 * for longer than PENDING_MESSAGE_IDLE_TIME.
 *
 * This handles the case where another consumer
 * crashed after receiving a message but before
 * acknowledging it.
 */
async function recoverPendingMessages(): Promise<void> {
    const pendingMessages =
        (await redis.xpending(
            ORDER_STREAM,
            CONSUMER_GROUP,
            "-",
            "+",
            10,
        )) as PendingMessage[];

    if (pendingMessages.length === 0) {
        return;
    }

    for (
        const pendingMessage of pendingMessages
    ) {
        const messageId =
            pendingMessage[0];

        const consumerName =
            pendingMessage[1];

        const idleTime =
            pendingMessage[2];

        if (
            messageId === undefined ||
            consumerName === undefined ||
            idleTime === undefined
        ) {
            continue;
        }

        if (
            idleTime <
            PENDING_MESSAGE_IDLE_TIME
        ) {
            continue;
        }

        /*
         * If the message already belongs to this
         * consumer, there is no need to claim it.
         *
         * It can be read through XREADGROUP "0".
         */
        if (
            consumerName === CONSUMER_NAME
        ) {
            continue;
        }

        console.log(
            `Attempting to recover Redis message ${messageId}`,
        );

        console.log(
            `Previous consumer: ${consumerName}`,
        );

        console.log(
            `Idle time: ${idleTime}ms`,
        );

        const claimed =
            (await redis.xclaim(
                ORDER_STREAM,
                CONSUMER_GROUP,
                CONSUMER_NAME,
                PENDING_MESSAGE_IDLE_TIME,
                messageId,
            )) as ClaimedMessage[];

        if (claimed.length === 0) {
            continue;
        }

        const claimedMessage =
            claimed[0];

        if (
            claimedMessage === undefined
        ) {
            continue;
        }

        const recoveredMessageId =
            claimedMessage[0];

        const recoveredFields =
            claimedMessage[1];

        if (
            recoveredMessageId === undefined ||
            recoveredFields === undefined
        ) {
            continue;
        }

        console.log(
            `Redis message ${recoveredMessageId} recovered`,
        );

        await processOrderMessage(
            recoveredMessageId,
            recoveredFields,
        );
    }
}

async function consumeOrders(): Promise<void> {
    await setupConsumerGroup();

    console.log(
        `Redis order consumer started as "${CONSUMER_NAME}"`,
    );

    while (true) {
        try {
            /*
             * STEP 1
             *
             * Recover abandoned messages
             * belonging to other consumers.
             */
            await recoverPendingMessages();

            /*
             * STEP 2
             *
             * Process pending messages belonging
             * to this consumer.
             */
            const pending =
                await readMessages("0");

            if (
                pending &&
                pending.some(
                    (
                        [, messages],
                    ) =>
                        messages.length > 0,
                )
            ) {
                for (
                    const [
                        _streamName,
                        messages,
                    ] of pending
                ) {
                    for (
                        const [
                            messageId,
                            fields,
                        ] of messages
                    ) {
                        await processOrderMessage(
                            messageId,
                            fields,
                        );
                    }
                }

                continue;
            }

            /*
             * STEP 3
             *
             * Read new messages.
             */
            const result =
                await readMessages(">");

            if (result) {
                for (
                    const [
                        _streamName,
                        messages,
                    ] of result
                ) {
                    for (
                        const [
                            messageId,
                            fields,
                        ] of messages
                    ) {
                        await processOrderMessage(
                            messageId,
                            fields,
                        );
                    }
                }
            }
        } catch (error: unknown) {
            console.error(
                "Redis consumer error:",
                error,
            );

            /*
             * IMPORTANT:
             *
             * We do NOT ACK the failed message.
             *
             * Redis therefore keeps it pending.
             *
             * A future consumer can recover it
             * using XCLAIM once it becomes idle
             * long enough.
             */
            await new Promise(
                (
                    resolve,
                ) =>
                    setTimeout(
                        resolve,
                        2000,
                    ),
            );
        }
    }
}

consumeOrders();