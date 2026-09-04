import {publishOrder} from "./redis-order-queue";
async function main(){
    const messageId = await publishOrder({orderId: crypto.randomUUID(),
        userId: "bd510b33-0d07-4080-b474-18b1fb09e921",
        side: "BUY",
        type: "LIMIT",
        qty: 0.1,
        price: 4000,});
    console.log("Order published to Redis:");
    console.log("Message ID:",messageId);
}
main().catch((error)=>{
    console.error("Redis order error:",error);
});