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