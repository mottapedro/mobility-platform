import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { applyConnectionSerializer } from "./serializing-pool";
import { ownershipImmutabilityExtension } from "./extensions/domainExtensions";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL não foi carregada.");
}

const pool = new Pool({
  connectionString,
});

// Serialize concurrent query() calls on the same PoolClient so Prisma's
// internal parallel sub-queries do not trigger the pg@8.x DeprecationWarning
// "Calling client.query() when the client is already executing a query".
applyConnectionSerializer(pool);

export { pool };

const adapter = new PrismaPg(pool);

// Apply domain extensions. Note: soft delete filtering is handled explicitly in
// Repository classes rather than via a global extension — more transparent and
// auditable per user feedback.
export const prisma = new PrismaClient({ adapter }).$extends(
  ownershipImmutabilityExtension,
);

export type PrismaTransaction = Prisma.TransactionClient;

let poolClosed = false;

export async function disconnectPrisma() {
  await prisma.$disconnect();

  if (!poolClosed) {
    poolClosed = true;
    await pool.end();
  }
}