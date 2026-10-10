import { prisma } from "./db";
import { measureDbOperation } from "./metrics";
export async function getBestAsk(
    asset: string,
    createdAfter?: Date
) {
    return measureDbOperation(()=> prisma.order.findFirst({
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
    }));
}

export async function getBestBid(
    asset: string,
    createdAfter?: Date
) {
    return measureDbOperation(()=> prisma.order.findFirst({
        where: {
            asset,
            side: "BUY",
            type:"LIMIT",
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
    }));
}

export async function calculateMarketBuyRequiredUSDT(
    asset: string,
    quantity: number,
): Promise<number> {
    let remainingQty = quantity;
    let requiredUSDT = 0;

    const asks = await measureDbOperation(()=>prisma.order.findMany({
    where: {
        asset,
        side: "SELL",
        type: "LIMIT",
        status: {
            in: ["OPEN", "PARTIALLY_FILLED"],
        },
        remainingQty: {
            gt: 0,
        },
        price: {
            not: null,
        },
    },
    select: {
        price: true,
        remainingQty: true,
    },
    orderBy: [
        { price: "asc" },
        { createdAt: "asc" },
    ],
}));

    for (const ask of asks) {
        if (remainingQty <= 0) {
            break;
        }

        if (ask.price === null) {
            continue;
        }

        const availableQty = Number(ask.remainingQty);
        const executableQty = Math.min(
            remainingQty,
            availableQty,
        );

        requiredUSDT +=
            executableQty * Number(ask.price);

        remainingQty -= executableQty;
    }

    if (remainingQty > 0) {
        throw new Error(
            "Insufficient market liquidity",
        );
    }

    return requiredUSDT;
}
