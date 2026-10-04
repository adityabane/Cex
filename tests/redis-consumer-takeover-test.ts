import { randomUUID } from "crypto";
import Redis from "ioredis";

const REDIS_URL =
    process.env.REDIS_URL ||
    "redis://localhost:6379";

const redis = new Redis(REDIS_URL);

const STREAM =
    `cex:test:takeover:${randomUUID()}`;

const GROUP =
    "cex-test-takeover-group";

const ORIGINAL_CONSUMER =
    "engine-main-test";

const RECOVERY_CONSUMER =
    "engine-recovery-test";

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

async function testMessageOwnedByOriginalConsumer(): Promise<string> {
    console.log("\n========================================");
    console.log(
        "TEST 1: MESSAGE OWNED BY ORIGINAL CONSUMER",
    );
    console.log("========================================");

    const messageId =
        await redis.xadd(
            STREAM,
            "*",
            "action",
            "CREATE",
            "orderId",
            randomUUID(),
            "userId",
            randomUUID(),
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
        "Expected message to be delivered",
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
        "Delivered message ID does not match",
    );

    console.log(
        "Message:",
        messageId,
    );

    console.log(
        "Owner:",
        ORIGINAL_CONSUMER,
    );

    console.log(
        "✅ Message is owned by original consumer",
    );

    return messageId;
}

async function testMessageIsPending(): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 2: MESSAGE IS PENDING");
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
        "✅ Message remains pending because it was not ACKed",
    );
}

async function testNewConsumerCannotReadPendingMessage(): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 3: NEW CONSUMER CANNOT READ OLD PENDING MESSAGE",
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
            "New consumer received no messages",
        );

        console.log(
            "✅ Pending message is not automatically delivered to another consumer",
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
        "New consumer:",
        RECOVERY_CONSUMER,
    );

    console.log(
        "Messages received:",
        messages.length,
    );

    console.log(
        "✅ Pending message is not automatically delivered to another consumer",
    );
}

async function testRecoveryWithXClaim(
    expectedMessageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 4: NEW CONSUMER RECOVERS MESSAGE",
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
                message[0] === expectedMessageId &&
                message[1] === ORIGINAL_CONSUMER,
        );

    assert(
        pendingMessage !== undefined,
        "Expected message to belong to original consumer",
    );

    const claimed =
        (await redis.xclaim(
            STREAM,
            GROUP,
            RECOVERY_CONSUMER,
            0,
            expectedMessageId,
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
        claimedMessage[0] === expectedMessageId,
        "Recovered message ID does not match",
    );

    console.log(
        "Message:",
        expectedMessageId,
    );

    console.log(
        "Original consumer:",
        ORIGINAL_CONSUMER,
    );

    console.log(
        "Recovery consumer:",
        RECOVERY_CONSUMER,
    );

    console.log(
        "✅ New consumer successfully claimed pending message",
    );
}

async function testMessageIsAcknowledged(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 5: RECOVERED MESSAGE IS ACKNOWLEDGED",
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

async function main(): Promise<void> {
    console.log(
        "========================================",
    );

    console.log(
        "   CEX V2 REDIS CONSUMER TAKEOVER TEST",
    );

    console.log(
        "========================================",
    );

    try {
        await createConsumerGroup();

        const messageId =
            await testMessageOwnedByOriginalConsumer();

        await testMessageIsPending();

        await testNewConsumerCannotReadPendingMessage();

        await testRecoveryWithXClaim(
            messageId,
        );

        await testMessageIsAcknowledged(
            messageId,
        );

        console.log(
            "\n========================================",
        );

        console.log(
            "   ✅ ALL TAKEOVER TESTS PASSED",
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
            "   ❌ TAKEOVER TEST FAILED",
        );

        console.error(
            "========================================",
        );

        console.error(error);

        process.exit(1);
    },
);