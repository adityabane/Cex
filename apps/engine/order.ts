import type { Asset, Account} from "./accounts.ts";
import {prisma} from "./db.ts";
import {lockBalance} from "./balance.ts";
import {BalanceLock} from "./accounts.ts";
export type OrderSide = "BUY" | "SELL" ;
export type OrderStatus =  "OPEN" | "PARTIALLY_FILLED" | "FILLED";
export type OrderType = "LIMIT"  | "MARKET";
export type Order = {
    id:string;
    userId:string;
    side : OrderSide;
    type:OrderType;
    asset :"BTC";
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
export async function createOrderInDb(id:string,userId:string,side:OrderSide,type:OrderType,qty:number,price?:number) {
    const order:Order={
        id,
        userId,
        side,
        type,
        asset: "BTC",
        qty,
        remainingqty: qty,
        price,
        status: "OPEN",
    };
    ValidateOrder(order);
    if (type === "MARKET") {
        throw new Error(
            "Market orders will be handled by the matching engine"
        );
    }
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
            : "BTC";
    await lockBalance(userId,assetToLock,requiredAmount);
    return prisma.order.create({
        data:{
            id,
            userId,
            side,
            type,
            asset: "BTC",
            quantity: qty,
            remainingQty: qty,
            price,
            status: "OPEN",
        },
    });
    
}
export function CreateOrder(id:string,userId:string,side:OrderSide,type:OrderType,qty:number,price?:number):Order{
    return {
        id,userId,side,type,asset:"BTC",qty,remainingqty:qty,price,status:"OPEN"
    }
}
export function ValidateOrder(order:Order):void{
    if(order.qty<=0){
        throw new Error("Invalid Order Quantity");
    }
    
    if(order.price===undefined || order.price<=0){
        throw new Error("Invalid Price Entry");
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
            BalanceLock("BTC",account,amount);
        }
    }
}
export function lockMarketBuyBalance(account:Account,order:Order,requireUSDT:number):void{
    if(order.type!=="MARKET" || order.side!=="BUY"){
        throw new Error("Expect a Market Buy Order");
    }
    BalanceLock("USDT",account,requireUSDT);
}