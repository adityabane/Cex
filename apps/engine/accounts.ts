export type Asset = "BTC" | "USDT";
export type Balance = {
    available:number;
    locked : number;
};
export type Account = {
    id:string;
    balances:Record<Asset,Balance>;
};
export function createAccount(id:string):Account{
    return {
        id,
        balances :{
            BTC:{
                available:0,
                locked:0,
            },
            USDT :{
                available:0,
                locked:0,
            },
        },
    };
}

export function BalanceLock(asset:Asset,account:Account,amount:number):void{
    if(amount<=0){
        throw new Error("Invalid Amount");
    }
    const Balance = account.balances[asset];
    if(Balance.available>=amount){
        Balance.available-=amount;
        Balance.locked += amount;
    }else{
        throw new Error("Insufficient Balance")
    }
}
export function settleTrade(buyer:Account,seller:Account,qty:number,price:number):void{
    const quoteAmount = qty*price;
    buyer.balances.USDT.locked -= quoteAmount;
    buyer.balances.BTC.available += qty;
    seller.balances.BTC.locked -= qty;
    seller.balances.USDT.available += quoteAmount;
}