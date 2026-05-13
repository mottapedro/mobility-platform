import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { applyConnectionSerializer } from "./serializing-pool";

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

export const prisma = new PrismaClient({ adapter });

let poolClosed = false;

export async function disconnectPrisma() {
  await prisma.$disconnect();

  if (!poolClosed) {
    poolClosed = true;
    await pool.end();
  }
}