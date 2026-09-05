import { PrismaClientExtends } from "@prisma/client/extension";
import { prisma } from "../engine/db";

export type OrderBookSnapshot = {
    type: "DEPTH_SNAPSHOT";
    asset: string;
    bids: [string, string][];
    asks: [string, string][];
};

export async function getOrderBookSnapshot(
    asset: string
): Promise<OrderBookSnapshot> {
    const orders = await prisma.order.findMany({
        where: {
            asset,
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
        orderBy: [
            {
                price: "asc",
            },
            {
                createdAt: "asc",
            },
        ],
    });

    const bids = new Map<string, number>();
    const asks = new Map<string, number>();

    for (const order of orders) {
        if (order.price === null) {
            continue;
        }

        const price = order.price.toString();
        const quantity = Number(order.remainingQty);

        const book =
            order.side === "BUY"
                ? bids
                : asks;

        book.set(
            price,
            (book.get(price) ?? 0) + quantity
        );
    }

    return {
        type: "DEPTH_SNAPSHOT",
        asset,
        bids: Array.from(bids.entries())
            .sort(
                (a, b) =>
                    Number(b[0]) - Number(a[0])
            ).map(([price,quantity])=>[
                price,
                quantity.toString(),
            ]),
        asks: Array.from(asks.entries())
            .sort(
                (a, b) =>
                    Number(a[0]) - Number(b[0])
            ).map(([price, quantity]) => [
                price,
                quantity.toString(),
            ])
    };
}