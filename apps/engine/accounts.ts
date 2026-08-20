export type Asset = "BTC" | "USDT";
export type Balance = {
    available:number;
    locked : number;
};
export type Account = {
    id:String;
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