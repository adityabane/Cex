import { prisma } from "./db";

export async function getBestAsk(
    asset: string,
    createdAfter?: Date
) {
    return prisma.order.findFirst({
        where: {
            asset,
            side: "SELL",
            status: {
                in: ["OPEN", "PARTIALLY_FILLED"],
            },
            remainingQty: {
                gt: 0,
            },
            ...(createdAfter && {
                createdAt: {
                    gte: createdAfter,
                },
            }),
        },
        orderBy: [
            {
                price: "asc",
            },
            {
                createdAt: "asc",
            },
        ],
    });
}

export async function getBestBid(
    asset: string,
    createdAfter?: Date
) {
    return prisma.order.findFirst({
        where: {
            asset,
            side: "BUY",
            status: {
                in: ["OPEN", "PARTIALLY_FILLED"],
            },
            remainingQty: {
                gt: 0,
            },
            ...(createdAfter && {
                createdAt: {
                    gte: createdAfter,
                },
            }),
        },
        orderBy: [
            {
                price: "desc",
            },
            {
                createdAt: "asc",
            },
        ],
    });
}