import {prisma} from "./db";
export async function createUser(email:string,password:string){
    if(!email || !password){
        throw new Error("Email and password are required");
    }
    const existingUser = await prisma.user.findUnique({
        where: {
            email,
        },
    });

    if (existingUser) {
        throw new Error("User already exists");
    }
    const passwordHash = await Bun.password.hash(password)
    return prisma.user.create({
        data:{
            email,
            passwordHash,
        },
    })
}