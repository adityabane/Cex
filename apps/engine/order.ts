import type { Asset, Account} from "./accounts.ts";
import {prisma} from "./db.ts";
import {getBalance,lockBalance} from "./balance.ts";
import {BalanceLock} from "./accounts.ts";
import {calculateMarketBuyRequiredUSDT} from "./orderbook-db.ts";
export type OrderSide = "BUY" | "SELL" ;
export type OrderStatus =  "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
export type OrderType = "LIMIT"  | "MARKET";
export type Order = {
    id:string;
    userId:string;
    side : OrderSide;
    type:OrderType;
    asset :string;
    qty:number;
    price?:number;
    remainingqty:number;
    status : OrderStatus;
}
export async function saveOrder(order:Order){
    return prisma.order.create({
        data:{
            id:order.id,
            userId:order.userId,
            side:order.side,
            type:order.type,
            asset:order.asset,
            quantity:order.qty,
            remainingQty:order.remainingqty,
            price:order.price ?? null,
            status:order.status,
        }
    })
    
}
export async function createOrderInDb(id:string,userId:string,asset:string,side:OrderSide,type:OrderType,qty:number,price?:number) {
    let marketBuyReservedUSDT: number | undefined;
    const normalizedAsset = asset.trim().toUpperCase();
    const order:Order={
        id,
        userId,
        side,
        type,
        qty,
        remainingqty: qty,
        price,
        status: "OPEN",
        asset: normalizedAsset,
    };
    ValidateOrder(order);
    if (type === "LIMIT") {
        if (price === undefined) {
            throw new Error("Price Undefined");
        }

        const requiredAmount =
            side === "BUY"
                ? qty * price
                : qty;

        const assetToLock =
            side === "BUY"
                ? "USDT"
                : normalizedAsset;

        await lockBalance(userId, assetToLock, requiredAmount);
    }
    if(type ==="MARKET" && side==="BUY"){
        const balance = await getBalance(userId, "USDT");
        if (!balance) {
            throw new Error("Balance not found for USDT");
        }
        if (balance.available.lte(0)) {
            throw new Error("Insufficient USDT balance");
        }
        const requiredUSDT = await calculateMarketBuyRequiredUSDT(
            normalizedAsset,
            qty,
        );

        if (balance.available.lt(requiredUSDT)) {
            throw new Error("Insufficient USDT balance");
        }
        marketBuyReservedUSDT = requiredUSDT
        await lockBalance(
            userId,
            "USDT",
            requiredUSDT,
        );
    }
    if (type === "MARKET" && side === "SELL") {
        const balance = await getBalance(userId, normalizedAsset);

        if (!balance) {
            throw new Error(`Balance not found for ${normalizedAsset}`);
        }

        if (balance.available.lt(qty)) {
            throw new Error(`Insufficient ${normalizedAsset} balance`);
        }

        await lockBalance(
            userId,
            normalizedAsset,
            qty,
        );
    }
    return prisma.order.create({
        data:{
            id,
            userId,
            side,
            type,
            asset: normalizedAsset,
            quantity: qty,
            remainingQty: qty,
            price,
            marketBuyReservedUSDT,
            status: "OPEN",
        },
    });
    
}
export function CreateOrder(id:string,userId:string,asset:string,side:OrderSide,type:OrderType,qty:number,price?:number):Order{
    return {
        id,userId,side,type,asset:asset.trim().toUpperCase(),qty,remainingqty:qty,price,status:"OPEN"
    }
}
export function ValidateOrder(order:Order):void{
    if(order.qty<=0){
        throw new Error("Invalid Order Quantity");
    }
    if(order.type === "LIMIT"){
        if(order.price===undefined || order.price<=0){
            throw new Error("Invalid Price Entry");
        }
    }
}
export function LockOrderBalance(account:Account,order:Order):void{
    ValidateOrder(order);
    if (order.type === "MARKET") {
    throw new Error("Market order balance locking will be handled by the matching engine");
    }
    if(order.type==="LIMIT"){
        if(order.price===undefined){
        throw new Error("Price Undefined")
        }
        if(order.side==="BUY"){
            const amount = order.qty * order.price;
            BalanceLock("USDT",account,amount);
        }
        if(order.side==="SELL"){
            const amount = order.qty;
            BalanceLock(order.asset,account,amount);
        }
    }
}
export function lockMarketBuyBalance(account:Account,order:Order,requireUSDT:number):void{
    if(order.type!=="MARKET" || order.side!=="BUY"){
        throw new Error("Expect a Market Buy Order");
    }
    BalanceLock("USDT",account,requireUSDT);
}
export async function getUserOrders(userId:string){
    return prisma.order.findMany({
        where:{
            userId,
        },
        orderBy:{
            createdAt:"desc"
        }
    })
}
export async function getOrderById(orderId:string){
    return prisma.order.findUnique({
        where:{
            id:orderId,
        },
    });
}