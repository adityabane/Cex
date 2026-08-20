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