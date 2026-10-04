import { randomUUID } from "crypto";
import Redis from "ioredis";

const REDIS_URL =
    process.env.REDIS_URL ||
    "redis://localhost:6379";

const redis = new Redis(REDIS_URL);

const STREAM =
    `cex:test:recovery:${randomUUID()}`;

const GROUP =
    "cex-test-order-engine";

const CONSUMER_1 =
    "test-consumer-1";

const CONSUMER_2 =
    "test-consumer-2";

type RedisMessage = [
    string,
    string[],
];

type RedisStreamResult = [
    string,
    RedisMessage[],
][];

type RedisConsumerGroup = unknown[];

type PendingSummary = [
    number,
    string | null,
    string | null,
    number,
];

type PendingMessage = [
    string,
    string,
    number,
    string,
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
    try {
        await redis.xgroup(
            "CREATE",
            STREAM,
            GROUP,
            "0",
            "MKSTREAM",
        );
    } catch (error: unknown) {
        if (
            error instanceof Error &&
            error.message.includes("BUSYGROUP")
        ) {
            return;
        }

        throw error;
    }
}

async function testConsumerGroupCreation(): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 1: CONSUMER GROUP CREATION");
    console.log("========================================");

    await createConsumerGroup();

    const groups =
        (await redis.xinfo(
            "GROUPS",
            STREAM,
        )) as RedisConsumerGroup;

    assert(
        Array.isArray(groups),
        "Expected Redis to return consumer groups",
    );

    assert(
        groups.length === 1,
        `Expected 1 consumer group, got ${groups.length}`,
    );

    console.log("Stream:", STREAM);
    console.log("Group:", GROUP);
    console.log("✅ Consumer group created correctly");
}

async function testMessageBecomesPending(): Promise<string> {
    console.log("\n========================================");
    console.log("TEST 2: MESSAGE BECOMES PENDING");
    console.log("========================================");

    const orderId = randomUUID();
    const userId = randomUUID();

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
        "Redis should return a message ID",
    );

    const result =
        (await redis.xreadgroup(
            "GROUP",
            GROUP,
            CONSUMER_1,
            "COUNT",
            1,
            "STREAMS",
            STREAM,
            ">",
        )) as RedisStreamResult | null;

    assert(
        result !== null,
        "Expected new message to be delivered",
    );

    assert(
        result.length > 0,
        "Expected at least one stream result",
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
        "Delivered message ID does not match XADD ID",
    );

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
        "Message:",
        messageId,
    );

    console.log(
        "Pending messages:",
        pending[0],
    );

    console.log(
        "✅ Unacknowledged message remains pending",
    );

    return messageId;
}

async function testPendingMessageRecovery(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 3: PENDING MESSAGE RECOVERY");
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
        pendingMessages.length >= 1,
        "Expected at least one pending message",
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
        "Expected our test message to be pending",
    );

    const claimed =
        (await redis.xclaim(
            STREAM,
            GROUP,
            CONSUMER_2,
            0,
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
        "Expected claimed Redis message",
    );

    assert(
        claimedMessage[0] === messageId,
        "Recovered message ID does not match",
    );

    const ackCount =
        await redis.xack(
            STREAM,
            GROUP,
            messageId,
        );

    assert(
        ackCount === 1,
        `Expected XACK to acknowledge 1 message, got ${ackCount}`,
    );

    const pendingAfterAck =
        (await redis.xpending(
            STREAM,
            GROUP,
        )) as PendingSummary;

    assert(
        Number(
            pendingAfterAck[0],
        ) === 0,
        `Expected 0 pending messages after ACK, got ${pendingAfterAck[0]}`,
    );

    console.log(
        "Recovered message:",
        messageId,
    );

    console.log(
        "Recovered by:",
        CONSUMER_2,
    );

    console.log(
        "ACK count:",
        ackCount,
    );

    console.log(
        "Pending after ACK:",
        pendingAfterAck[0],
    );

    console.log(
        "✅ Pending message recovered and acknowledged",
    );
}

async function testFailedMessageRemainsPending(): Promise<string> {
    console.log("\n========================================");
    console.log("TEST 4: FAILED MESSAGE REMAINS PENDING");
    console.log("========================================");

    const messageId =
        await redis.xadd(
            STREAM,
            "*",
            "action",
            "CREATE",
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
        "Expected malformed message to be created",
    );

    const result =
        (await redis.xreadgroup(
            "GROUP",
            GROUP,
            CONSUMER_1,
            "COUNT",
            1,
            "STREAMS",
            STREAM,
            ">",
        )) as RedisStreamResult | null;

    assert(
        result !== null,
        "Expected malformed message to be delivered",
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
        "Expected one malformed message",
    );

    const pending =
        (await redis.xpending(
            STREAM,
            GROUP,
        )) as PendingSummary;

    assert(
        Number(pending[0]) === 1,
        `Expected failed message to remain pending, got ${pending[0]}`,
    );

    console.log(
        "Failed message:",
        messageId,
    );

    console.log(
        "Pending messages:",
        pending[0],
    );

    console.log(
        "✅ Failed message was not acknowledged",
    );

    return messageId;
}

async function testFailedMessageRecovery(
    messageId: string,
): Promise<void> {
    console.log("\n========================================");
    console.log("TEST 5: FAILED MESSAGE RECOVERY");
    console.log("========================================");

    const claimed =
        (await redis.xclaim(
            STREAM,
            GROUP,
            CONSUMER_2,
            0,
            messageId,
        )) as ClaimedMessage[];

    assert(
        claimed.length === 1,
        `Expected 1 recovered message, got ${claimed.length}`,
    );

    const claimedMessage =
        claimed[0];

    assert(
        claimedMessage !== undefined,
        "Expected claimed Redis message",
    );

    assert(
        claimedMessage[0] === messageId,
        "Recovered failed message ID does not match",
    );

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
        `Expected no pending messages, got ${pending[0]}`,
    );

    console.log(
        "Recovered message:",
        messageId,
    );

    console.log(
        "ACK count:",
        ackCount,
    );

    console.log(
        "Pending after recovery:",
        pending[0],
    );

    console.log(
        "✅ Failed message can be recovered and acknowledged",
    );
}

async function testAcknowledgedMessageNotRedelivered(): Promise<void> {
    console.log("\n========================================");
    console.log(
        "TEST 6: ACKNOWLEDGED MESSAGE NOT REDELIVERED",
    );
    console.log("========================================");

    const result =
        (await redis.xreadgroup(
            "GROUP",
            GROUP,
            CONSUMER_1,
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
            "✅ Acknowledged messages are not redelivered",
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
        `Expected no new messages, got ${messages.length}`,
    );

    console.log(
        "✅ Acknowledged messages are not redelivered as new messages",
    );
}

async function main(): Promise<void> {
    console.log("========================================");
    console.log("   CEX V2 REDIS RECOVERY TESTS");
    console.log("========================================");

    try {
        await testConsumerGroupCreation();

        const messageId =
            await testMessageBecomesPending();

        await testPendingMessageRecovery(
            messageId,
        );

        const failedMessageId =
            await testFailedMessageRemainsPending();

        await testFailedMessageRecovery(
            failedMessageId,
        );

        await testAcknowledgedMessageNotRedelivered();

        console.log("\n========================================");
        console.log(
            "   ✅ ALL REDIS RECOVERY TESTS PASSED",
        );
        console.log("========================================");
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
            "   ❌ REDIS RECOVERY TEST FAILED",
        );

        console.error(
            "========================================",
        );

        console.error(error);

        process.exit(1);
    },
);