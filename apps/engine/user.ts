import {prisma} from "./db";
export async function createUser(){
    return prisma.user.create({
        data:{},
    })
}