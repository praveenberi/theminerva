import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient();
export { Prisma };
export type Tx = Prisma.TransactionClient;

export const dec = (n: number | string) => new Prisma.Decimal(n);
