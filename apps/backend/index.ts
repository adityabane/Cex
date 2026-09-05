import "./websocket";
import express from "express";
import {createUser} from "../engine/user"
import {publishOrder} from "../engine/redis-order-queue";
import {createBalance} from "../engine/balance";
import {getBalance} from "../engine/balance";
import {getUserOrders} from "../engine/order";
import { redis } from "../engine/redis";
const app = express();
app.use(express.json());
app.get("/",(_req,res)=>{
    res.json({
        message:"CEX v2 Backend Running"
    });
});
app.post("/users",async (_req,res)=>{
    try{
        const user = await createUser();
        res.status(201).json(user);
    }catch(error){
        console.error("Create user error:",error);
        res.status(500).json({
            error:"Failed to create user"
        })
    }
})
app.post("/orders",async (req,res )=>{
    try{
        const {
            userId,
            side,
            type,
            qty,
            price,
        } = req.body;
        if (!userId || !side || !type || !qty) {
            return res.status(400).json({
                error: "userId, side, type and qty are required",
            });
        }
        const orderId = crypto.randomUUID();
        console.log("Order received by backend:");
        console.log({
            orderId,
            userId,
            side,
            type,
            qty,
            price,
        });
        const messageId = await publishOrder({
            orderId,
            userId,
            side,
            type,
            qty,
            price
        });
        console.log("Order published to Redis:");
        console.log("Redis Message ID:", messageId);

        res.status(201).json({
            message:"Order queued",
            orderId,
            redisMessageId:messageId,
        });
    } catch (error) {
        console.error("Queue order error:", error);

        res.status(500).json({
            error: "Failed to queue order",
        });
    }  
});
app.delete("/orders/:orderId", async (req, res) => {
    try {
        const { orderId } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                error: "userId is required",
            });
        }

        const redisMessageId = await redis.xadd(
            "cex:orders",
            "*",
            {
                action:"CANCEL",
                orderId,
                userId,
            }
        );

        return res.json({
            message: "Cancellation queued",
            orderId,
            redisMessageId,
        });
    } catch (error) {
        console.error("Cancel order error:", error);

        return res.status(500).json({
            error: "Failed to queue cancellation",
        });
    }
});
app.post("/users/:userId/balances", async (req ,res )=>{
    try {
        const {userId} = req.params;
        const {asset,amount} = req.body;
        if (!asset || amount === undefined) {
            return res.status(400).json({
                error: "asset and amount are required",
            });
        }
        const balance = await createBalance(
            userId,
            asset,
            amount
        );
        res.status(201).json(balance);
    } catch (error) {
        console.error("Create balance error:", error);
        res.status(400).json({
            error: "Failed to create balance",
        });
    }
})
app.get("/users/:userId/balances/:asset", async (req, res) => {
    try {
        const { userId, asset } = req.params;
        const balance = await getBalance(userId, asset);
        if (!balance) {
            return res.status(404).json({
                error: `Balance not found for ${asset}`,
            });
        }
        res.json(balance);
    } catch (error) {
        console.error("Get balance error:", error);

        res.status(500).json({
            error: "Failed to get balance",
        });
    }
});
app.get("/users/:userId/orders", async (req, res) => {
    try {
        const { userId } = req.params;
        const orders = await getUserOrders(userId);
        res.json(orders);
    } catch (error) {
        console.error("Get orders error:", error);
        res.status(500).json({
            error: "Failed to get orders",
        });
    }
});
app.listen(3000,()=>{
    console.log("CEX v2 Backend Running on http://localhost:3000")
});