import Redis from "ioredis";

const REDIS_URL =
    process.env.REDIS_URL ||
    "redis://localhost:6379";

const redis = new Redis(REDIS_URL);

const STREAM =
    "cex:test:consumer:recovery:type";

const GROUP =
    "cex-test-consumer-recovery-type";

const CONSUMER =
    "engine-main-test";

type RedisMessage = [
    string,
    string[],
];

type RedisStreamResult = [
    string,
    RedisMessage[],
][];

type PendingSummary = [
    number,
    string | null,
    string | null,
    number,
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

async function main(): Promise<void> {
    console.log(
        "========================================",
    );

    console.log(
        "   REDIS RECOVERY TYPE/SMOKE TEST",
    );

    console.log(
        "========================================");

    try {
        await redis.xgroup(
            "CREATE",
            STREAM,
            GROUP,
            "0",
            "MKSTREAM",
        );

        const messageId =
            await redis.xadd(
                STREAM,
                "*",
                "action",
                "CREATE",
                "orderId",
                "test-order",
                "userId",
                "test-user",
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
            "Expected XADD to return a message ID",
        );

        const result =
            (await redis.xreadgroup(
                "GROUP",
                GROUP,
                CONSUMER,
                "COUNT",
                1,
                "STREAMS",
                STREAM,
                ">",
            )) as RedisStreamResult | null;

        assert(
            result !== null,
            "Expected XREADGROUP result",
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
            "Message ID mismatch",
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
            "Pending:",
            pending[0],
        );

        console.log(
            "✅ Redis recovery types and basic flow are valid",
        );
    } finally {
        await cleanup();
        await redis.quit();
    }
}

main().catch(
    (error: unknown) => {
        console.error(
            "\n❌ REDIS RECOVERY TYPE/SMOKE TEST FAILED",
        );

        console.error(error);

        process.exit(1);
    },
);