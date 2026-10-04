import {prisma} from "../apps/engine/db";

async function main() {

    const users = await prisma.user.findMany({
        where:{
            email:{
                endsWith:"@concurrency.test"
            }
        },
        select:{
            id:true,
            email:true
        },
    });

    console.log(`Found ${users.length} concurrency test users`);

    const userIds = users.map(user => user.id);

    if (userIds.length === 0) {
        console.log("Nothing to clean");
        return;
    }

    const orders = await prisma.order.findMany({
        where:{
            userId:{
                in:userIds
            }
        },
        select:{
            id:true
        },
    });

    const orderIds = orders.map(order => order.id);

    if (orderIds.length > 0) {

        await prisma.trade.deleteMany({
            where:{
                OR:[
                    {
                        buyOrderId:{
                            in:orderIds
                        }
                    },
                    {
                        sellOrderId:{
                            in:orderIds
                        }
                    }
                ]
            }
        });

        await prisma.order.deleteMany({
            where:{
                id:{
                    in:orderIds
                }
            }
        });
    }

    await prisma.balance.deleteMany({
        where:{
            userId:{
                in:userIds
            }
        }
    });

    await prisma.user.deleteMany({
        where:{
            id:{
                in:userIds
            }
        }
    });

    console.log("Concurrency test data cleaned successfully");
}

main()
    .catch(error => {
        console.error(error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });