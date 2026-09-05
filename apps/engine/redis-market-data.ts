import {redis} from "./redis";
const MARKET_DATA_STREAM = "cex:market-data";
export type TradeMarketEvent = {
    type :"TRADE";
    asset:string;
    price:number;
    quantity:number;
};
export async function publishTradeEvent(
    event:TradeMarketEvent
){
    return redis.xadd(
        MARKET_DATA_STREAM,"*",
        {
            type:event.type,
            asset:event.asset,
            price:event.price.toString(),
            quantity:event.quantity.toString(),
        }
    );
}