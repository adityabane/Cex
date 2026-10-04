import {randomUUID} from "crypto";
import Redis from "ioredis";

const REDIS_URL =
    process.env.REDIS_URL ||
    "redis://localhost:6379";

const redis = new Redis(REDIS_URL);

const STREAM =
    `cex:test:consumer-recovery:${randomUUID()}`;

const GROUP =
    "cex-test-consumer-recovery";

const ORIGINAL_CONSUMER =
    "engine-main-test";

const RECOVERY_CONSUMER =
    "engine-recovery-test";

const RECOVERY_IDLE_TIME =
    5000;

type RedisMessage = [
    string,
    string[],
];

type RedisStreamResult = [
    string,
    RedisMessage[],
][];

type PendingMessage = [
    string,
    string,
    number,
    string,
];

type PendingSummary = [
    number,
    string | null,
    string | null,
    number,
];

type ClaimedMessage = [
    string,
    string[],
];

function assert(
    condition: boolean,
    message: string,
): asserts condition {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

function sleep(
    milliseconds: number,
): Promise<void> {
    return new Promise(
        (
            resolve,
        ) =>
            setTimeout(
                resolve,
                milliseconds,
            ),
    );
}

async function cleanup(): Promise<void> {
    try {
        await redis.del(STREAM);
    } catch {
        // Ignore cleanup errors.
    }
}

async function createConsumerGroup(): Promise<void> {
    await redis.xgroup(
        "CREATE",
        STREAM,
        GROUP,
        "0",
        "MKSTREAM",
    );
}

async function addOrderMessage(): Promise<string> {
    const orderId =
        randomUUID();

    const userId =
        randomUUID();

    const messageId =
        await redis.xadd(
            STREAM,
            "*",
            "action",
            "CREATE",
            "orderId",
            orderId,
            "userId",
            userId,
            "side",
            "BUY",
            "type",
            "LIMIT",
            "qty",
            "1",
            "price",
            "100",
        );

    assert(
        messageId !== null,
        "Expected Redis to return a message ID",
    );

    return messageId;
}

async function deliverMessageToOriginalConsumer(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 1: ORIGINAL CONSUMER RECEIVES MESSAGE",
    );
    console.log("========================================");

    const result =
        (await redis.xreadgroup(
            "GROUP",
            GROUP,
            ORIGINAL_CONSUMER,
            "COUNT",
            1,
            "STREAMS",
            STREAM,
            ">",
        )) as RedisStreamResult | null;

    assert(
        result !== null,
        "Expected original consumer to receive message",
    );

    assert(
        result.length > 0,
        "Expected stream result",
    );

    const streamResult =
        result[0];

    assert(
        streamResult !== undefined,
        "Expected stream result",
    );

    const messages =
        streamResult[1];

    assert(
        messages.length === 1,
        `Expected 1 message, got ${messages.length}`,
    );

    const message =
        messages[0];

    assert(
        message !== undefined,
        "Expected Redis message",
    );

    assert(
        message[0] === messageId,
        "Received message ID does not match",
    );

    console.log(
        "Message:",
        messageId,
    );

    console.log(
        "Consumer:",
        ORIGINAL_CONSUMER,
    );

    console.log(
        "✅ Original consumer received message",
    );
}

async function verifyMessageIsPending(): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 2: MESSAGE IS PENDING",
    );
    console.log("========================================");

    const pending =
        (await redis.xpending(
            STREAM,
            GROUP,
        )) as PendingSummary;

    assert(
        Number(pending[0]) === 1,
        `Expected 1 pending message, got ${pending[0]}`,
    );

    console.log(
        "Pending messages:",
        pending[0],
    );

    console.log(
        "✅ Message is pending",
    );
}

async function verifyMessageIsNotRecoveredTooEarly(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 3: MESSAGE IS NOT RECOVERED TOO EARLY",
    );
    console.log("========================================");

    const pendingMessages =
        (await redis.xpending(
            STREAM,
            GROUP,
            "-",
            "+",
            10,
        )) as PendingMessage[];

    assert(
        pendingMessages.length > 0,
        "Expected pending messages",
    );

    const pendingMessage =
        pendingMessages.find(
            (
                message: PendingMessage,
            ) =>
                message[0] === messageId,
        );

    assert(
        pendingMessage !== undefined,
        "Expected test message to be pending",
    );

    const idleTime =
        pendingMessage[2];

    assert(
        idleTime < RECOVERY_IDLE_TIME,
        `Expected idle time below ${RECOVERY_IDLE_TIME}ms, got ${idleTime}ms`,
    );

    console.log(
        "Current idle time:",
        idleTime,
        "ms",
    );

    console.log(
        "Recovery threshold:",
        RECOVERY_IDLE_TIME,
        "ms",
    );

    console.log(
        "✅ Message is below recovery threshold",
    );
}

async function waitForRecoveryThreshold(): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 4: WAIT FOR RECOVERY THRESHOLD",
    );
    console.log("========================================");

    console.log(
        `Waiting ${RECOVERY_IDLE_TIME + 500}ms for message to become recoverable...`,
    );

    await sleep(
        RECOVERY_IDLE_TIME + 500,
    );

    console.log(
        "✅ Recovery threshold reached",
    );
}

async function recoverPendingMessage(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 5: RECOVER PENDING MESSAGE",
    );
    console.log("========================================");

    const pendingMessages =
        (await redis.xpending(
            STREAM,
            GROUP,
            "-",
            "+",
            10,
        )) as PendingMessage[];

    assert(
        pendingMessages.length > 0,
        "Expected pending messages",
    );

    const pendingMessage =
        pendingMessages.find(
            (
                message: PendingMessage,
            ) =>
                message[0] === messageId,
        );

    assert(
        pendingMessage !== undefined,
        "Expected test message to be pending",
    );

    const originalConsumer =
        pendingMessage[1];

    const idleTime =
        pendingMessage[2];

    assert(
        originalConsumer ===
            ORIGINAL_CONSUMER,
        `Expected original consumer to be ${ORIGINAL_CONSUMER}, got ${originalConsumer}`,
    );

    assert(
        idleTime >= RECOVERY_IDLE_TIME,
        `Expected idle time >= ${RECOVERY_IDLE_TIME}ms, got ${idleTime}ms`,
    );

    const claimed =
        (await redis.xclaim(
            STREAM,
            GROUP,
            RECOVERY_CONSUMER,
            RECOVERY_IDLE_TIME,
            messageId,
        )) as ClaimedMessage[];

    assert(
        claimed.length === 1,
        `Expected 1 claimed message, got ${claimed.length}`,
    );

    const claimedMessage =
        claimed[0];

    assert(
        claimedMessage !== undefined,
        "Expected claimed message",
    );

    assert(
        claimedMessage[0] === messageId,
        "Recovered message ID does not match",
    );

    console.log(
        "Message:",
        messageId,
    );

    console.log(
        "Original consumer:",
        originalConsumer,
    );

    console.log(
        "Recovery consumer:",
        RECOVERY_CONSUMER,
    );

    console.log(
        "Idle time:",
        idleTime,
        "ms",
    );

    console.log(
        "✅ Pending message recovered successfully",
    );
}

async function verifyRecoveredMessage(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 6: RECOVERED MESSAGE CAN BE ACKNOWLEDGED",
    );
    console.log("========================================");

    const ackCount =
        await redis.xack(
            STREAM,
            GROUP,
            messageId,
        );

    assert(
        ackCount === 1,
        `Expected ACK count 1, got ${ackCount}`,
    );

    const pending =
        (await redis.xpending(
            STREAM,
            GROUP,
        )) as PendingSummary;

    assert(
        Number(pending[0]) === 0,
        `Expected 0 pending messages, got ${pending[0]}`,
    );

    console.log(
        "ACK count:",
        ackCount,
    );

    console.log(
        "Pending messages:",
        pending[0],
    );

    console.log(
        "✅ Recovered message acknowledged successfully",
    );
}

async function verifyNoNewMessages(): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 7: RECOVERED MESSAGE IS NOT REDIVERED",
    );
    console.log("========================================");

    const result =
        (await redis.xreadgroup(
            "GROUP",
            GROUP,
            RECOVERY_CONSUMER,
            "COUNT",
            10,
            "STREAMS",
            STREAM,
            ">",
        )) as RedisStreamResult | null;

    if (result === null) {
        console.log(
            "No new messages returned",
        );

        console.log(
            "✅ No duplicate delivery",
        );

        return;
    }

    assert(
        result.length > 0,
        "Expected stream result",
    );

    const streamResult =
        result[0];

    assert(
        streamResult !== undefined,
        "Expected stream result",
    );

    const messages =
        streamResult[1];

    assert(
        messages.length === 0,
        `Expected 0 new messages, got ${messages.length}`,
    );

    console.log(
        "New messages:",
        messages.length,
    );

    console.log(
        "✅ Recovered message is not redelivered",
    );
}

async function main(): Promise<void> {
    console.log(
        "========================================",
    );

    console.log(
        "   CEX V2 REDIS CONSUMER RECOVERY TEST",
    );

    console.log(
        "========================================",
    );

    try {
        await createConsumerGroup();

        const messageId =
            await addOrderMessage();

        await deliverMessageToOriginalConsumer(
            messageId,
        );

        await verifyMessageIsPending();

        await verifyMessageIsNotRecoveredTooEarly(
            messageId,
        );

        await waitForRecoveryThreshold();

        await recoverPendingMessage(
            messageId,
        );

        await verifyRecoveredMessage(
            messageId,
        );

        await verifyNoNewMessages();

        console.log(
            "\n========================================",
        );

        console.log(
            "   ✅ ALL CONSUMER RECOVERY TESTS PASSED",
        );

        console.log(
            "========================================",
        );
    } finally {
        await cleanup();
        await redis.quit();
    }
}

main().catch(
    (error: unknown) => {
        console.error(
            "\n========================================",
        );

        console.error(
            "   ❌ CONSUMER RECOVERY TEST FAILED",
        );

        console.error(
            "========================================",
        );

        console.error(error);

        process.exit(1);
    },
);