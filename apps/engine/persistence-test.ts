import {prisma}  from "./db";
async function main(){
    console.log("=== PERSISTENCE TEST ===");
    const users = await prisma.user.findMany({
        include:{
            balances:true,
            orders:true,
        },
    });
    console.log("\nUsers:");
    console.dir(users,{depth:null});
    const orders = await prisma.order.findMany({
        orderBy:{
            createdAt:"asc",
        },
    });
    console.log("\nOrders:");
    console.dir(orders, { depth: null });

    const trades = await prisma.trade.findMany({
        orderBy: {
            createdAt: "asc",
        },
    });

    console.log("\nTrades:");
    console.dir(trades, { depth: null });

    console.log("\n=== PERSISTENCE TEST COMPLETE ===");
}

main()
    .catch((error) => {
        console.error(error);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
