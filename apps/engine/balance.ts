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
export async function lockBalance(userId:string,asset:string,amount:number){
    if (amount <= 0) {
        throw new Error("Invalid lock amount");
    }
    return prisma.$transaction(async (tx)=>{
        const balance = await tx.balance.findUnique({
            where:{
                userId_asset:{
                    userId,
                    asset,
                },
            },
        });
        if (!balance) {
                throw new Error(
                    `Balance not found for ${asset}`
                );
            }
    
            if (balance.available.lt(amount)) {
                throw new Error(
                    `Insufficient ${asset} balance`
                );
            }
            return tx.balance.update({
                where:{
                    userId_asset:{
                        userId,
                        asset,
                    },
                },
                data:{
                    available:{
                        decrement:amount,
                    },
                    locked:{
                        increment:amount,
                    },
                },
            });
    });
}
export async function unlockBalance(userId:string,asset:string,amount:number){
    if(amount<=0){
        throw new Error("Invalid unlock amount");
    }
    return prisma.$transaction(async(tx)=>{
        const balance = await tx.balance.findUnique({
            where:{
                userId_asset:{
                    userId,
                    asset,
                },
            },
        })
        if(!balance){
            throw new Error(`Balance not found for ${asset}`);
        }
        if (balance.locked.lt(amount)) {
            throw new Error(
                `Insufficient locked ${asset} balance`
            );
        }
        return tx.balance.update({
            where: {
                userId_asset: {
                    userId,
                    asset,
                },
            },
            data: {
                locked: {
                    decrement: amount,
                },
                available: {
                    increment: amount,
                },
            },
        });

    })
}