import type { Asset, Account} from "./accounts";
import {BalanceLock} from "./accounts";
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
        if(order.price===undefined || order.side==="BUY"){
            const amount = order.qty*order.price;
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