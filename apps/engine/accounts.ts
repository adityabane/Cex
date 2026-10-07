export type Asset = string;
export type Balance = {
    available:number;
    locked : number;
};
export type Account = {
    id:string;
    balances:Record<string,Balance>;
};
export function createAccount(id:string):Account{
    return {
        id,
        balances :{
            USDT :{
                available:0,
                locked:0,
            },
        },
    };
}
export function ensureBalance(
    account: Account,
    asset: string,
): Balance {
    const normalizedAsset = asset.trim().toUpperCase();

    if (!account.balances[normalizedAsset]) {
        account.balances[normalizedAsset] = {
            available: 0,
            locked: 0,
        };
    }

    return account.balances[normalizedAsset];
}
export function BalanceLock(asset:Asset,account:Account,amount:number):void{
    if(amount<=0){
        throw new Error("Invalid Amount");
    }
    const Balance = account.balances[asset];
    if(Balance===undefined){
        throw new Error("Balance is Undefined")
    }
    if(Balance.available>=amount){
        Balance.available-=amount;
        Balance.locked += amount;
    }else{
        throw new Error("Insufficient Balance")
    }
}
export function settleTrade(buyer:Account,seller:Account,asset:string,qty:number,price:number):void{
    const quoteAmount = qty*price;
    const normalizedAsset = asset.trim().toUpperCase();
    if (!buyer.balances.USDT) {
        throw new Error("Buyer USDT balance not found");
    }

    if (!buyer.balances[normalizedAsset]) {
        throw new Error(
            `Buyer ${normalizedAsset} balance not found`,
        );
    }

    if (!seller.balances[normalizedAsset]) {
        throw new Error(
            `Seller ${normalizedAsset} balance not found`,
        );
    }

    if (!seller.balances.USDT) {
        throw new Error("Seller USDT balance not found");
    }

    buyer.balances.USDT.locked -= quoteAmount;
    buyer.balances[normalizedAsset].available += qty;

    seller.balances[normalizedAsset].locked -= qty;
    seller.balances.USDT.available += quoteAmount;
}
