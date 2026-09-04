import type {ServerWebSocket} from "bun";
const clients = new Set<ServerWebSocket>();
const server = Bun.serve({
    port:3001,
    fetch(req,server){
        const success = server.upgrade(req);
        if(success){
            return undefined;
        }
        return new Response("WebSocket server running");
    },
    websocket:{
        open(ws){
            clients.add(ws);
            console.log("Websocket client connected");
            console.log("Connected clients:",clients.size);
            ws.send(
                JSON.stringify({
                    type:"CONNECTED",
                    message:"Connected to CEX WebSocket",
                })
            );
        },
        message(ws,message){
            console.log("WebSocket message:",message.toString());
            ws.send(
                JSON.stringify({
                    type:"PONG",
                    message:"WebSocket server received your message",
                })
            );
        },
        close(ws){
            clients.delete(ws);
            console.log("WebSocket client disconnected");
            console.log("Connected clients:",clients.size);
        },
    },
});
console.log(`CEX WebSocket Server running on ws://localhost:${server.port}`);