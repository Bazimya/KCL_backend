const { PrismaClient } = require('@prisma/client')

// Prisma reads the connection string from DATABASE_URL (see .env / .env_example).
const prisma = new PrismaClient()

const connectDb = async () => {
    await prisma.$connect()
    console.log('connected to MySQL DB via Prisma')
}

module.exports = { prisma, connectDb }
