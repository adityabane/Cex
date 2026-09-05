import { redis } from "./redis";

const MARKET_DATA_STREAM = "cex:market-data";

export type DepthEvent = {
    type: "DEPTH";
    asset: string;
    bids: [string, string][];
    asks: [string, string][];
};

export async function publishDepthEvent(
    event: DepthEvent
) {
    return redis.xadd(
        MARKET_DATA_STREAM,
        "*",
        {
            type: event.type,
            asset: event.asset,
            bids: JSON.stringify(event.bids),
            asks: JSON.stringify(event.asks),
        }
    );
}