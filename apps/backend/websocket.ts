import type { ServerWebSocket } from "bun";
import { redis } from "../engine/redis";
import { getOrderBookSnapshot } from "./orderbook-snapshot";
import { verifyToken } from "./auth";

const MARKET_DATA_STREAM = "cex:market-data";
const CONSUMER_GROUP = "websocket-server";
const CONSUMER_NAME = `ws-${process.pid}`;

type WebSocketData = {
    userId: string;
};

type ClientState = {
    subscriptions: Set<string>;
};

const clients = new Map<
    ServerWebSocket<WebSocketData>,
    ClientState
>();

type RedisMessage = [string, string[]];
type RedisStreamResult = [string, RedisMessage[]][];

async function setupConsumerGroup() {
    try {
        await redis.xgroup(
            "CREATE",
            MARKET_DATA_STREAM,
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
            console.log(
                `Redis consumer group "${CONSUMER_GROUP}" already exists`,
            );
        } else {
            throw error;
        }
    }
}

function fieldsToObject(fields: string[]) {
    const event: Record<string, any> = {};

    for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];

        if (
            key !== undefined &&
            value !== undefined
        ) {
            event[key] = value;
        }
    }

    if (event.type === "DEPTH") {
        if (typeof event.bids === "string") {
            event.bids = JSON.parse(event.bids);
        }

        if (typeof event.asks === "string") {
            event.asks = JSON.parse(event.asks);
        }
    }

    return event;
}

async function consumeMarketData() {
    console.log(
        "Redis market-data consumer started...",
    );

    while (true) {
        if (clients.size === 0) {
            await new Promise((resolve) =>
                setTimeout(resolve, 1000),
            );

            continue;
        }

        try {
            const result =
                (await redis.xreadgroup(
                    "GROUP",
                    CONSUMER_GROUP,
                    CONSUMER_NAME,
                    "COUNT",
                    10,
                    "STREAMS",
                    MARKET_DATA_STREAM,
                    ">",
                )) as RedisStreamResult | null;

            if (!result) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 1000),
                );

                continue;
            }

            for (const [, messages] of result) {
                for (const [
                    messageId,
                    fields,
                ] of messages) {
                    const event =
                        fieldsToObject(fields);

                    console.log(
                        "Market event received:",
                        messageId,
                        event,
                    );

                    for (const [
                        client,
                        state,
                    ] of clients) {
                        const subscriptions =
                            state.subscriptions;

                        if (
                            event.type === "DEPTH" &&
                            subscriptions.has(
                                `depth.${event.asset}`,
                            )
                        ) {
                            client.send(
                                JSON.stringify(event),
                            );
                        }

                        if (
                            event.type ===
                                "ORDER_STATUS" &&
                            subscriptions.has(
                                `orders.${event.userId}`,
                            )
                        ) {
                            client.send(
                                JSON.stringify(event),
                            );
                        }
                    }

                    await redis.xack(
                        MARKET_DATA_STREAM,
                        CONSUMER_GROUP,
                        messageId,
                    );
                }
            }
        } catch (error) {
            console.error(
                "Market-data consumer error:",
                error,
            );

            await new Promise((resolve) =>
                setTimeout(resolve, 1000),
            );
        }
    }
}

const server = Bun.serve({
    port: 3001,

    async fetch(req, server) {
        const url = new URL(req.url);

        const token =
            url.searchParams.get("token");

        if (!token) {
            return new Response(
                "WebSocket authentication required",
                {
                    status: 401,
                },
            );
        }

        let userId: string;

        try {
            userId = await verifyToken(token);
        } catch {
            return new Response(
                "Invalid or expired WebSocket token",
                {
                    status: 401,
                },
            );
        }

        const success = server.upgrade(req, {
            data: {
                userId,
            },
        });

        if (success) {
            return undefined;
        }

        return new Response(
            "WebSocket upgrade failed",
            {
                status: 400,
            },
        );
    },

    websocket: {
        data: {} as WebSocketData,

        open(ws) {
            clients.set(ws, {
                subscriptions: new Set(),
            });

            console.log(
                `WebSocket client connected. User: ${ws.data.userId}. Total clients: ${clients.size}`,
            );

            ws.send(
                JSON.stringify({
                    type: "CONNECTED",
                    message:
                        "Connected to CEX WebSocket",
                }),
            );
        },

        async message(ws, message) {
            const messageText =
                message.toString();

            console.log(
                "WebSocket message received:",
                messageText,
            );

            const state = clients.get(ws);

            if (!state) {
                return;
            }

            const subscriptions =
                state.subscriptions;

            /*
             * -------------------------------------
             * SUBSCRIBE
             * -------------------------------------
             */

            if (
                messageText.startsWith(
                    "SUBSCRIBE ",
                )
            ) {
                const stream =
                    messageText
                        .slice(10)
                        .trim();

                /*
                 * Private order streams can only
                 * belong to the authenticated user.
                 */

                if (
                    stream.startsWith(
                        "orders.",
                    )
                ) {
                    const requestedUserId =
                        stream.slice(7);

                    if (
                        requestedUserId !==
                        ws.data.userId
                    ) {
                        ws.send(
                            JSON.stringify({
                                type: "ERROR",
                                message:
                                    "Unauthorized order subscription",
                            }),
                        );

                        console.log(
                            `Unauthorized order subscription attempt. User: ${ws.data.userId}, Requested: ${requestedUserId}`,
                        );

                        return;
                    }
                }

                subscriptions.add(stream);

                ws.send(
                    JSON.stringify({
                        type: "SUBSCRIBED",
                        stream,
                    }),
                );

                console.log(
                    `Client ${ws.data.userId} subscribed to ${stream}`,
                );

                if (
                    stream.startsWith(
                        "depth.",
                    )
                ) {
                    const asset =
                        stream.slice(6);

                    const snapshot =
                        await getOrderBookSnapshot(
                            asset,
                        );

                    ws.send(
                        JSON.stringify(
                            snapshot,
                        ),
                    );
                }

                return;
            }

            /*
             * -------------------------------------
             * UNSUBSCRIBE
             * -------------------------------------
             */

            if (
                messageText.startsWith(
                    "UNSUBSCRIBE ",
                )
            ) {
                const stream =
                    messageText
                        .slice(12)
                        .trim();

                if (
                    stream.startsWith(
                        "orders.",
                    )
                ) {
                    const requestedUserId =
                        stream.slice(7);

                    if (
                        requestedUserId !==
                        ws.data.userId
                    ) {
                        ws.send(
                            JSON.stringify({
                                type: "ERROR",
                                message:
                                    "Unauthorized order subscription",
                            }),
                        );

                        return;
                    }
                }

                subscriptions.delete(
                    stream,
                );

                ws.send(
                    JSON.stringify({
                        type: "UNSUBSCRIBED",
                        stream,
                    }),
                );

                console.log(
                    `Client ${ws.data.userId} unsubscribed from ${stream}`,
                );

                return;
            }

            ws.send(
                JSON.stringify({
                    type: "PONG",
                    message:
                        "WebSocket server received your message",
                }),
            );
        },

        close(ws) {
            clients.delete(ws);

            console.log(
                `WebSocket client disconnected. User: ${ws.data.userId}. Total clients: ${clients.size}`,
            );
        },
    },
});

console.log(
    `CEX WebSocket Server running on ws://localhost:${server.port}`,
);

await setupConsumerGroup();

consumeMarketData();