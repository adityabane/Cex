import { prisma } from "./db.ts";

console.log("Starting Prisma test...");

try {
    const users = await prisma.user.findMany();

    console.log("Prisma connection successful!");
    console.log("Users:", users);
} catch (error) {
    console.error("Prisma connection failed:");
    console.error(error);
} finally {
    await prisma.$disconnect();
}