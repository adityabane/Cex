import type {ServerWebSocket} from "bun";
import {redis} from "../engine/redis";
import {getOrderBookSnapshot} from "./orderbook-snapshot";
const MARKET_DATA_STREAM = "cex:market-data";
const CONSUMER_GROUP = "websocket-server";
const CONSUMER_NAME =  `ws-${process.pid}`;

const clients = new Map<ServerWebSocket,Set<string>>();
type RedisMessage = [string,string[]];
type RedisStreamResult = [string,RedisMessage[]][];

async function setupConsumerGroup(){
    try{
        await redis.xgroup(
            MARKET_DATA_STREAM,
            {
                type:"CREATE",
                group:CONSUMER_GROUP,
                id:"0",
                options:{
                    MKSTREAM:true,
                }
            }
        );
        console.log(`Redis consumer group "${CONSUMER_GROUP}" created`);
    }catch(error){
        if(
            error instanceof Error && error.message.includes("BUSYGROUP")
        ){
            console.log(`Redis consumer group "${CONSUMER_GROUP}" already exists`)
        }else {
            throw error;
        }
    }
}
function fieldsToObject(fields: string[]) {
    const event: Record<string, string> = {};

    for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];

        if (key !== undefined && value !== undefined) {
            event[key] = value;
        }
    }

    return event;
}
async function consumeMarketData() {
    console.log("Redis market-data consumer started...");

    while (true) {
        if (clients.size === 0) {
            await new Promise((resolve) =>
                setTimeout(resolve, 1000)
            );
            continue;
        }

        try {
            const result = await redis.xreadgroup(
                CONSUMER_GROUP,
                CONSUMER_NAME,
                [MARKET_DATA_STREAM],
                [">"],
                {
                    count:10,
                }
            ) as RedisStreamResult | null;

            if (!result) {
                await new Promise((resolve) =>
                    setTimeout(resolve, 1000)
                );
                continue;
            }

            for (const [, messages] of result) {
                for (const [messageId, fields] of messages) {
                    const event = fieldsToObject(fields);

                    console.log(
                        "Market event received:",
                        messageId,
                        event
                    );

                    for (const [client, subscriptions] of clients) {
                        if (subscriptions.has(`depth.${event.asset}`)) {
                            client.send(
                                JSON.stringify(event)
                            );
                        }
                        if (
                            event.type === "ORDER_STATUS" &&
                            subscriptions.has(`orders.${event.userId}`)
                        ) {
                            client.send(
                                JSON.stringify(event)
                            );
                        }
                    }
                    await redis.xack(
                        MARKET_DATA_STREAM,
                        CONSUMER_GROUP,
                        messageId
                    );
                }
            }
        } catch (error) {
            console.error(
                "Market-data consumer error:",
                error
            );

            await new Promise((resolve) =>
                setTimeout(resolve, 1000)
            );
        }
    }
}

const server = Bun.serve({
    port: 3001,

    fetch(req, server) {
        const success = server.upgrade(req);

        if (success) {
            return undefined;
        }

        return new Response(
            "WebSocket server running"
        );
    },

    websocket: {
        open(ws) {
            clients.set(ws,new Set());

            console.log(
                `WebSocket client connected. Total clients: ${clients.size}`
            );

            ws.send(
                JSON.stringify({
                    type: "CONNECTED",
                    message: "Connected to CEX WebSocket",
                })
            );
        },

        async message(ws, message) {
            const messageText = message.toString();
            console.log(
                "WebSocket message received:",
                messageText.toString()
            );
            const subscriptions = clients.get(ws);
            if (!subscriptions) {
                return;
            }

            if (messageText.startsWith("SUBSCRIBE ")) {
                const stream = messageText.slice(10).trim();
                subscriptions.add(stream);
                ws.send(
                    JSON.stringify({
                        type: "SUBSCRIBED",
                        stream,
                    })
                );
                console.log(
                    `Client subscribed to ${stream}`
                );
                if (stream.startsWith("depth.")) {
                const asset = stream.slice(6);

                const snapshot = await getOrderBookSnapshot(asset);

                ws.send(
                    JSON.stringify(snapshot)
                );
            }
                return;
            }

            if (messageText.startsWith("UNSUBSCRIBE ")) {
                const stream = messageText.slice(12).trim();

                subscriptions.delete(stream);

                ws.send(
                    JSON.stringify({
                        type: "UNSUBSCRIBED",
                        stream,
                    })
                );

                console.log(
                    `Client unsubscribed from ${stream}`
                );

                return;
            }
            ws.send(
                JSON.stringify({
                    type: "PONG",
                    message:
                        "WebSocket server received your message",
                })
            );
        },

        close(ws) {
            clients.delete(ws);

            console.log(
                `WebSocket client disconnected. Total clients: ${clients.size}`
            );
        },
    },
});

console.log(
    `CEX WebSocket Server running on ws://localhost:${server.port}`
);

await setupConsumerGroup();
consumeMarketData();
