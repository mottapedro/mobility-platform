import path from "node:path";
import { defineConfig } from "prisma/config";

const migrationsPath = process.env.PRISMA_MIGRATIONS_PATH?.trim();

if (!migrationsPath) {
  throw new Error("PRISMA_MIGRATIONS_PATH is required; materialize the authorized migration catalog first");
}

export default defineConfig({
  schema: "../prisma/schema.prisma",
  migrations: {
    path: path.resolve(migrationsPath),
  },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
