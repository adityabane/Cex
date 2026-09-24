import "./websocket";
import express from "express";
import {createUser} from "../engine/user"
import {publishOrder} from "../engine/redis-order-queue";
import {createBalance} from "../engine/balance";
import {getBalance} from "../engine/balance";
import {getUserOrders,getOrderById} from "../engine/order";
import { redis } from "../engine/redis";
import { createToken } from "./auth";
import {prisma} from "../engine/db";
import { authMiddleware } from "./auth-middleware";
import type {AuthRequest } from "./auth-middleware";
const app = express();
app.use(express.json());
app.get("/",(_req,res)=>{
    res.json({
        message:"CEX v2 Backend Running"
    });
});
app.post("/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                error: "email and password are required",
            });
        }
        const user = await prisma.user.findUnique({
            where: {
                email,
            },
        });
        if (!user) {
            return res.status(401).json({
                error: "Invalid email or password",
            });
        }
        const validPassword = await Bun.password.verify(
            password,
            user.passwordHash,
        );
        if (!validPassword) {
            return res.status(401).json({
                error: "Invalid email or password",
            });
        }
        const token = await createToken(user.id);
        res.json({
            token,
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
            error: "Login failed",
        });
    }
});
app.post("/users",async (req,res)=>{
    try{
        const {email,password} = req.body;
        if (!email || !password) {
            return res.status(400).json({
                error: "email and password are required",
            });
        }
        const user = await createUser(email,password);
        res.status(201).json({
            id:user.id,
            email:user.email,
        });
    }catch(error){
        console.error("Create user error:",error);
        res.status(500).json({
            error:"Failed to create user"
        })
    }
})
app.post("/orders",authMiddleware, async (req:AuthRequest,res )=>{
    try{
        const {
            side,
            type,
            qty,
            price,
        } = req.body;
        const userId = req.userId;
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
app.delete("/orders/:orderId",authMiddleware, async (req:AuthRequest, res) => {
    try {
        const { orderId } = req.params;
        const  userId  = req.userId;

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
app.post("/users/:userId/balances",authMiddleware, async (req:AuthRequest ,res )=>{
    try {
        const {userId} = req.params;
        if (userId !== req.userId) {
            return res.status(403).json({
            error: "You cannot modify another user's balance",
        });
}
        const {asset,amount} = req.body;
        if (!asset || amount === undefined) {
            return res.status(400).json({
                error: "asset and amount are required",
            });
        }
        if (typeof userId !== "string") {
            return res.status(400).json({
                error: "Invalid user ID",
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
app.get("/users/:userId/balances/:asset",authMiddleware, async (req:AuthRequest, res) => {
    try {
        const { userId, asset } = req.params;
        if (userId !== req.userId) {
            return res.status(403).json({
                error: "You cannot access another user's balance",
            });
        }
        if (typeof userId !== "string" || typeof asset !== "string") {
            return res.status(400).json({
                error: "Invalid user ID",
            });
        }
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
app.get("/users/:userId/orders", authMiddleware,async (req:AuthRequest, res) => {
    try {
        const { userId } = req.params;
        if (userId !== req.userId) {
            return res.status(403).json({
                error: "You cannot access another user's orders",
            });
        }
        if (typeof userId !== "string") {
            return res.status(400).json({
                error: "Invalid user ID",
            });
        }
        const orders = await getUserOrders(userId);
        res.json(orders);
    } catch (error) {
        console.error("Get orders error:", error);
        res.status(500).json({
            error: "Failed to get orders",
        });
    }
});
app.get("/orders/:orderId",authMiddleware,async (req:AuthRequest , res )=>{
    try{
        const {orderId} = req.params;
        if (typeof orderId !== "string") {
            return res.status(400).json({
                error: "Invalid order ID",
            });
        }
        const order = await getOrderById(orderId);
        
        if(!order){
            return res.status(404).json({
                error:"Order not Found",
            });
        }
        if (order.userId !== req.userId) {
            return res.status(404).json({
                error: "Order not found",
            });
        }
        res.json(order)
    }catch(error){
        console.error("Get order error:",error);
        res.status(500).json({
            error:"Failed to get order",
        })
    }
})
app.listen(3000,()=>{
    console.log("CEX v2 Backend Running on http://localhost:3000")
});