import type { Asset, Account} from "./accounts";
import {BalanceLock} from "./accounts";
export type OrderSide = "BUY" | "SELL" ;
export type OrderStatus = "OPEN";
export type Order = {
    id:String;
    userId:String;
    side : OrderSide;
    asset :"BTC";
    qty:number;
    price:number;
    status : OrderStatus;
}
export function CreateOrder(id:String,userId:String,side:OrderSide,qty:number,price:number):Order{
    return {
        id,userId,side,asset:"BTC",qty,price,status:"OPEN"
    }
}
export function ValidateOrder(order:Order):void{
    if(order.qty<=0){
        throw new Error("Invalid Order Quantity");
    }
    if(order.price<=0){
        throw new Error("Invalid Price Entry");
    }
}
export function LockOrderBalance(account:Account,order:Order):void{
    ValidateOrder(order);
    if(order.side==="BUY"){
        const amount = order.qty*order.price;
        BalanceLock("USDT",account,amount);
    }
    if(order.side==="SELL"){
        const amount = order.qty;
        BalanceLock("BTC",account,amount);
    }
}