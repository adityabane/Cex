import { redis } from "./redis";
async function main() {
    await redis.set("cex:test", "redis-working");
    const value = await redis.get("cex:test");
    console.log("Redis value:", value);
}
main().catch((error) => {
    console.error("Redis error:", error);
});