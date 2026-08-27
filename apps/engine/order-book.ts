import type {Order} from "./order.ts";
import type {Account} from "./accounts.ts";
import {settleTrade} from "./accounts.ts";
export class Orderbook {
    private bids :Order[]=[];
    private asks :Order[]=[];
    constructor(private accounts:Map<string,Account>){}
    add(order:Order):void{
        if(order.type==="MARKET"){
            throw new Error("Market orders must be executed immediately and cannot be added to the order book");
        }
        if(order.side==="BUY"){
            this.bids.push(order);
            this.bids.sort((a,b)=>(b.price ?? 0)-(a.price ?? 0));
            return;
        }
        this.asks.push(order);
        this.asks.sort((a,b)=>(a.price ?? 0)-(b.price ?? 0));
    }
    getBids():Order[]{
        return [...this.bids];
    }
    getAsks():Order[]{
        return [...this.asks];
    }  
    match():void{
        while(this.bids.length>0 && this.asks.length>0){
            const bestBid = this.bids[0];
            const bestAsk = this.asks[0];
            if(bestBid===undefined || bestAsk===undefined){
                throw new Error("Bids and Ask Undefined")
            }
            if(bestBid.price===undefined || bestAsk.price===undefined || bestBid.price< bestAsk.price ){
                break;
            }
            const executionPrice = bestAsk.price;
            // if(executionPrice ===undefined){
            //     throw new Error("Unable to determine Execution Price");
            // }
            const tradeqty = Math.min(bestAsk.remainingqty,bestBid.remainingqty);
            const buyer = this.accounts.get(bestBid.userId);
            const seller = this.accounts.get(bestAsk.userId);
            if (!buyer || !seller) {
                throw new Error("Account not found");
            }
            settleTrade(buyer,seller,tradeqty,executionPrice);
            console.log("TRADE");
            console.log("price:", executionPrice);
            console.log("quantity:", tradeqty);
            bestBid.remainingqty -= tradeqty;
            bestAsk.remainingqty -= tradeqty;
            if (bestBid.remainingqty === 0) {
                bestBid.status = "FILLED";
                this.bids.shift();
            } else {
                bestBid.status = "PARTIALLY_FILLED";
            }
            if (bestAsk.remainingqty === 0) {
                bestAsk.status = "FILLED";
                this.asks.shift();
            } else {
                bestAsk.status = "PARTIALLY_FILLED";
            }
        }
    }
    getMarketBuyCost(qty:number):number{
        let remaining = qty;
        let cost = 0;
        for (const ask of this.asks){
            if(ask.price ===undefined){
                continue;
            }
            const matchQty = Math.min(remaining,ask.remainingqty);
            cost += matchQty*ask.price;
            remaining -= matchQty;
            if(remaining===0){
                return cost;
            }
        }
        throw new Error("Insufficient market Sell Liquidity");
    }
    executeMarketOrder(order:Order):void{
        if(order.type != "MARKET"){
            throw new Error("Expect a Market Order");
        }
        if(order.remainingqty <=0){
            throw new Error("Market Order Quantity must be greater than zero");
        }
        if(order.side ==="BUY"){
            this.executeMarketBuy(order);
            return;
        }
        this.executeMarketSell(order);
    }
    private executeMarketBuy(order:Order):void{
        while(order.remainingqty>0 && this.asks.length>0){
            const bestAsk = this.asks[0];
            if(bestAsk===undefined ||bestAsk.price ===undefined){
                break;
            }
            const buyer = this.accounts.get(order.userId);
            const seller = this.accounts.get(bestAsk.userId);
            if(!buyer || !seller){
                throw new Error("Account not Found");
            }
            const tradeqty = Math.min(order.remainingqty,bestAsk.remainingqty);
            settleTrade(buyer,seller,tradeqty,bestAsk.price);
            console.log("TRADE");
            console.log("price:",bestAsk.price);
            console.log("quantity:",tradeqty);
            order.remainingqty -= tradeqty;
            bestAsk.remainingqty -= tradeqty;
            if(bestAsk.remainingqty ===0){
                bestAsk.status ="FILLED";
                this.asks.shift();
            }else{
                bestAsk.status="PARTIALLY_FILLED";
            }
        }
        if(order.remainingqty===0){
            order.status ="FILLED";
        }
    }
    private executeMarketSell(order:Order):void{
        while(order.remainingqty>0 && this.bids.length>0){
            const bestBid = this.bids[0];
            if(bestBid===undefined ||bestBid.price ===undefined){
                break;
            }
            const buyer = this.accounts.get(bestBid.userId);
            const seller = this.accounts.get(order.userId);
            if(!buyer || !seller){
                throw new Error("Account not Found");
            }
            const tradeqty = Math.min(order.remainingqty,bestBid.remainingqty);
            settleTrade(buyer,seller,tradeqty,bestBid.price);
            console.log("TRADE");
            console.log("price:",bestBid.price);
            console.log("quantity:",tradeqty);
            order.remainingqty -= tradeqty;
            bestBid.remainingqty -= tradeqty;
            if(bestBid.remainingqty === 0){
                bestBid.status ="FILLED";
                this.bids.shift();
            }else{
                bestBid.status ="PARTIALLY_FILLED";
            }
        };
        if(order.remainingqty ===0){
            order.status ="FILLED";
        }
    } 
}