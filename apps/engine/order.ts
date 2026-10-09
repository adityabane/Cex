import type { Asset, Account} from "./accounts.ts";
import {prisma} from "./db.ts";
import {getBalance,lockBalance} from "./balance.ts";
import {BalanceLock} from "./accounts.ts";
import {calculateMarketBuyRequiredUSDT} from "./orderbook-db.ts";
export type OrderSide = "BUY" | "SELL" ;
export type OrderStatus =  "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
export type OrderType = "LIMIT"  | "MARKET";
export type Order = {
    id:string;
    userId:string;
    side : OrderSide;
    type:OrderType;
    asset :string;
    qty:number;
    price?:number;
    remainingqty:number;
    status : OrderStatus;
}
export async function saveOrder(order:Order){
    return prisma.order.create({
        data:{
            id:order.id,
            userId:order.userId,
            side:order.side,
            type:order.type,
            asset:order.asset,
            quantity:order.qty,
            remainingQty:order.remainingqty,
            price:order.price ?? null,
            status:order.status,
        }
    })
    
}
export async function createOrderInDb(
    id: string,
    userId: string,
    asset: string,
    side: OrderSide,
    type: OrderType,
    qty: number,
    price?: number,
) {
    let marketBuyReservedUSDT: number | undefined;
    const normalizedAsset = asset.trim().toUpperCase();

    const order: Order = {
        id,
        userId,
        side,
        type,
        qty,
        remainingqty: qty,
        price,
        status: "OPEN",
        asset: normalizedAsset,
    };

    ValidateOrder(order);

    return prisma.$transaction(async (tx) => {
        // Redis may deliver the same order more than once.
        // If the order already exists, do not lock its balance again.
        // Serialize concurrent processing attempts for the same order ID.
        
await tx.$queryRaw<Array<{ locked: number }>>`
    WITH lock_guard AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
            hashtextextended(${id}, 0)
        )
    )
    SELECT 1 AS locked
    FROM lock_guard
`;

        const existingOrder = await tx.order.findUnique({
            where: {
                id,
            },
        });

        if (existingOrder) {
            return existingOrder;
        }

        const lock = async (assetToLock: string, amount: number) => {
            if (amount <= 0) {
                throw new Error("Invalid lock amount");
            }

            const balance = await tx.balance.findUnique({
                where: {
                    userId_asset: {
                        userId,
                        asset: assetToLock,
                    },
                },
            });

            if (!balance) {
                throw new Error(
                    `Balance not found for ${assetToLock}`,
                );
            }

            if (balance.available.lt(amount)) {
                throw new Error(
                    `Insufficient ${assetToLock} balance`,
                );
            }

            await tx.balance.update({
                where: {
                    userId_asset: {
                        userId,
                        asset: assetToLock,
                    },
                },
                data: {
                    available: {
                        decrement: amount,
                    },
                    locked: {
                        increment: amount,
                    },
                },
            });
        };

        if (type === "LIMIT") {
            if (price === undefined) {
                throw new Error("Price Undefined");
            }

            const requiredAmount =
                side === "BUY"
                    ? qty * price
                    : qty;

            const assetToLock =
                side === "BUY"
                    ? "USDT"
                    : normalizedAsset;

            await lock(assetToLock, requiredAmount);
        }

        if (type === "MARKET" && side === "BUY") {
            const balance = await tx.balance.findUnique({
                where: {
                    userId_asset: {
                        userId,
                        asset: "USDT",
                    },
                },
            });

            if (!balance) {
                throw new Error("Balance not found for USDT");
            }

            if (balance.available.lte(0)) {
                throw new Error("Insufficient USDT balance");
            }

            // This function currently reads through Prisma itself,
            // so we calculate the required amount before the transaction
            // lock is applied below.
            const requiredUSDT =
                await calculateMarketBuyRequiredUSDT(
                    normalizedAsset,
                    qty,
                );

            if (balance.available.lt(requiredUSDT)) {
                throw new Error("Insufficient USDT balance");
            }

            marketBuyReservedUSDT = requiredUSDT;

            await lock(
                "USDT",
                requiredUSDT,
            );
        }

        if (type === "MARKET" && side === "SELL") {
            const balance = await tx.balance.findUnique({
                where: {
                    userId_asset: {
                        userId,
                        asset: normalizedAsset,
                    },
                },
            });

            if (!balance) {
                throw new Error(
                    `Balance not found for ${normalizedAsset}`,
                );
            }

            if (balance.available.lt(qty)) {
                throw new Error(
                    `Insufficient ${normalizedAsset} balance`,
                );
            }

            await lock(
                normalizedAsset,
                qty,
            );
        }

        return tx.order.create({
            data: {
                id,
                userId,
                side,
                type,
                asset: normalizedAsset,
                quantity: qty,
                remainingQty: qty,
                price,
                marketBuyReservedUSDT,
                status: "OPEN",
            },
        });
    });
}
export function CreateOrder(id:string,userId:string,asset:string,side:OrderSide,type:OrderType,qty:number,price?:number):Order{
    return {
        id,userId,side,type,asset:asset.trim().toUpperCase(),qty,remainingqty:qty,price,status:"OPEN"
    }
}
export function ValidateOrder(order:Order):void{
    if(order.qty<=0){
        throw new Error("Invalid Order Quantity");
    }
    if(order.type === "LIMIT"){
        if(order.price===undefined || order.price<=0){
            throw new Error("Invalid Price Entry");
        }
    }
}
export function LockOrderBalance(account:Account,order:Order):void{
    ValidateOrder(order);
    if (order.type === "MARKET") {
    throw new Error("Market order balance locking will be handled by the matching engine");
    }
    if(order.type==="LIMIT"){
        if(order.price===undefined){
        throw new Error("Price Undefined")
        }
        if(order.side==="BUY"){
            const amount = order.qty * order.price;
            BalanceLock("USDT",account,amount);
        }
        if(order.side==="SELL"){
            const amount = order.qty;
            BalanceLock(order.asset,account,amount);
        }
    }
}
export function lockMarketBuyBalance(account:Account,order:Order,requireUSDT:number):void{
    if(order.type!=="MARKET" || order.side!=="BUY"){
        throw new Error("Expect a Market Buy Order");
    }
    BalanceLock("USDT",account,requireUSDT);
}
export async function getUserOrders(userId:string){
    return prisma.order.findMany({
        where:{
            userId,
        },
        orderBy:{
            createdAt:"desc"
        }
    })
}
export async function getOrderById(orderId:string){
    return prisma.order.findUnique({
        where:{
            id:orderId,
        },
    });
}