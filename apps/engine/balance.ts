import {prisma} from "./db";
export async function getBalance(userId:string,asset:string){
    return prisma.balance.findUnique({
        where:{
            userId_asset:{
                userId,
                asset
            },
        },
    });
}
export async function createBalance(userId:string,asset:string,amount:number){
    return prisma.balance.create({
        data:{
            userId:userId,
            asset,
            available:amount,
            locked:0,
        },
    });
}