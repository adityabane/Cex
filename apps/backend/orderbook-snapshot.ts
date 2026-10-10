
import { prisma } from "../engine/db";

export type OrderBookSnapshot = {
    type: "DEPTH_SNAPSHOT";
    asset: string;
    bids: [string, string][];
    asks: [string, string][];
};

type PriceLevel = {
    price: string;
    quantity: string;
};

export async function getOrderBookSnapshot(
    asset: string,
): Promise<OrderBookSnapshot> {
    const normalizedAsset = asset.trim().toUpperCase();

    const [bids, asks] = await Promise.all([
        prisma.$queryRaw<PriceLevel[]>`
            SELECT
                price::text AS price,
                SUM("remainingQty")::text AS quantity
            FROM "Order"
            WHERE asset = ${normalizedAsset}
              AND side = 'BUY'
              AND status IN ('OPEN', 'PARTIALLY_FILLED')
              AND "remainingQty" > 0
              AND price IS NOT NULL
            GROUP BY price
            ORDER BY price DESC
            LIMIT 20
        `,
        prisma.$queryRaw<PriceLevel[]>`
            SELECT
                price::text AS price,
                SUM("remainingQty")::text AS quantity
            FROM "Order"
            WHERE asset = ${normalizedAsset}
              AND side = 'SELL'
              AND status IN ('OPEN', 'PARTIALLY_FILLED')
              AND "remainingQty" > 0
              AND price IS NOT NULL
            GROUP BY price
            ORDER BY price ASC
            LIMIT 20
        `,
    ]);

    return {
        type: "DEPTH_SNAPSHOT",
        asset: normalizedAsset,
        bids: bids.map(({ price, quantity }) => [
            price,
            quantity,
        ]),
        asks: asks.map(({ price, quantity }) => [
            price,
            quantity,
        ]),
    };
}
