
import { prisma } from "./db.ts";
import {createUser} from "./user.ts";
import {createBalance} from "./balance.ts";
async function main() {
    console.log("CEX V2 Engine Started");
    const users = await createUser();
    console.log("Created User:",{users})
    const balance = await createBalance(users.id,"USDT",1000);
    console.log("Created Balance:",balance);
}

main()
    .catch((error) => {
        console.error(error);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });