
import { getOrderBookSnapshot } from "../backend/orderbook-snapshot";
import { publishDepthEvent } from "./redis-depth";

type UpdateState = {
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    dirty: boolean;
};

const states = new Map<string, UpdateState>();
const UPDATE_INTERVAL_MS = 250;

function scheduleNext(
    asset: string,
    state: UpdateState,
): void {
    if (state.timer !== null || state.running) {
        return;
    }

    state.timer = setTimeout(async () => {
        state.timer = null;
        state.running = true;
        state.dirty = false;

        try {
            const snapshot = await getOrderBookSnapshot(asset);

            await publishDepthEvent({
                type: "DEPTH",
                asset: snapshot.asset,
                bids: snapshot.bids,
                asks: snapshot.asks,
            });
        } catch (error) {
            // Preserve the update request so it can be retried.
            state.dirty = true;
            console.error(
                `Depth update failed for ${asset}:`,
                error,
            );
        } finally {
            state.running = false;

            if (state.dirty) {
                scheduleNext(asset, state);
            } else {
                states.delete(asset);
            }
        }
    }, UPDATE_INTERVAL_MS);
}

export function scheduleDepthUpdate(asset: string): void {
    const normalizedAsset = asset.trim().toUpperCase();

    let state = states.get(normalizedAsset);

    if (!state) {
        state = {
            timer: null,
            running: false,
            dirty: false,
        };

        states.set(normalizedAsset, state);
    }

    state.dirty = true;
    scheduleNext(normalizedAsset, state);
}
