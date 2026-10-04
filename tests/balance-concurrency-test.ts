import { randomUUID } from "crypto";
import { prisma } from "../apps/engine/db.ts";
import { lockBalance } from "../apps/engine/balance.ts";

const INITIAL_BALANCE = 100;
const LOCK_AMOUNT = 100;

function assert(
    condition: boolean,
    message: string,
) {
    if (!condition) {
        throw new Error(`❌ ${message}`);
    }
}

async function main() {
    console.log("========================================");
    console.log("   CEX V2 BALANCE CONCURRENCY TEST");
    console.log("========================================");

    const user = await prisma.user.create({
        data: {
            email: `balance-concurrency-${randomUUID()}@test.com`,
            passwordHash: "test-password-hash",
        },
    });

    try {
        /*
         * -------------------------------------
         * 1. CREATE INITIAL BALANCE
         * -------------------------------------
         */

        console.log("\n1. Creating test balance...");

        await prisma.balance.create({
            data: {
                userId: user.id,
                asset: "USDT",
                available: INITIAL_BALANCE,
                locked: 0,
            },
        });

        console.log(
            `✅ Created ${INITIAL_BALANCE} USDT available`,
        );

        /*
         * -------------------------------------
         * 2. RUN TWO CONCURRENT LOCKS
         * -------------------------------------
         *
         * Both operations try to lock the
         * entire 100 USDT balance.
         *
         * Only ONE should succeed.
         */

        console.log(
            "\n2. Running two concurrent balance locks...",
        );

        const results = await Promise.allSettled([
            lockBalance(
                user.id,
                "USDT",
                LOCK_AMOUNT,
            ),

            lockBalance(
                user.id,
                "USDT",
                LOCK_AMOUNT,
            ),
        ]);

        console.log("\nLock results:");

        for (const [index, result] of results.entries()) {
            if (result.status === "fulfilled") {
                console.log(
                    `Lock ${index + 1}: ✅ succeeded`,
                );
            } else {
                console.log(
                    `Lock ${index + 1}: ❌ failed`,
                    result.reason,
                );
            }
        }

        /*
         * -------------------------------------
         * 3. COUNT SUCCESSFUL LOCKS
         * -------------------------------------
         */

        console.log(
            "\n3. Checking number of successful locks...",
        );

        const successfulLocks =
            results.filter(
                (result) =>
                    result.status === "fulfilled",
            ).length;

        console.log(
            "Successful locks:",
            successfulLocks,
        );

        /*
         * With only 100 USDT available,
         * exactly ONE lock of 100 USDT
         * should succeed.
         */

        assert(
            successfulLocks === 1,
            `Expected exactly 1 successful lock, but ${successfulLocks} succeeded`,
        );

        console.log(
            "✅ Exactly one lock succeeded",
        );

        /*
         * -------------------------------------
         * 4. CHECK FINAL BALANCE
         * -------------------------------------
         */

        console.log(
            "\n4. Checking final balance...",
        );

        const finalBalance =
            await prisma.balance.findUnique({
                where: {
                    userId_asset: {
                        userId: user.id,
                        asset: "USDT",
                    },
                },
            });

        assert(
            !!finalBalance,
            "Final balance was not found",
        );

        if (!finalBalance) {
            throw new Error(
                "Final balance is null",
            );
        }

        console.log(
            "Final balance:",
            finalBalance,
        );

        /*
         * -------------------------------------
         * 5. CHECK BALANCE INVARIANTS
         * -------------------------------------
         */

        console.log(
            "\n5. Checking balance invariants...",
        );

        const available =
            Number(finalBalance.available);

        const locked =
            Number(finalBalance.locked);

        const total =
            available + locked;

        console.log(
            "Available:",
            available,
        );

        console.log(
            "Locked:",
            locked,
        );

        console.log(
            "Total:",
            total,
        );

        assert(
            available >= 0,
            `Available balance became negative: ${available}`,
        );

        assert(
            locked >= 0,
            `Locked balance became negative: ${locked}`,
        );

        assert(
            locked === LOCK_AMOUNT,
            `Expected 100 USDT locked, but found ${locked}`,
        );

        assert(
            total === INITIAL_BALANCE,
            `Balance conservation failed: expected ${INITIAL_BALANCE}, but found ${total}`,
        );

        console.log(
            "✅ Balance invariants are correct",
        );

        /*
         * -------------------------------------
         * COMPLETE
         * -------------------------------------
         */

        console.log("\n========================================");
        console.log("   ✅ BALANCE CONCURRENCY TEST PASSED");
        console.log("========================================");

    } finally {

        /*
         * -------------------------------------
         * CLEANUP
         * -------------------------------------
         */

        console.log(
            "\nCleaning up test data...",
        );

        await prisma.balance.deleteMany({
            where: {
                userId: user.id,
            },
        });

        await prisma.user.delete({
            where: {
                id: user.id,
            },
        });

        console.log(
            "✅ Test data cleaned",
        );
    }
}

main()
    .catch((error) => {
        console.error(
            "\n========================================",
        );
        console.error(
            "   ❌ BALANCE CONCURRENCY TEST FAILED",
        );
        console.error(
            "========================================",
        );

        console.error(error);

        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });