import { Prisma } from "@prisma/client";

/**
 * Domain-level Prisma extension.
 *
 * Responsibilities:
 *   - Enforce immutability for ownership fields (rootDriverId, operationalOwnerId).
 *   - Inject soft-delete filters for protected models.
 *
 * NOTE: If a model does not implement soft-delete (no `deletedAt` column),
 * do NOT inject a filter for it. Otherwise Prisma will error at runtime.
 */

export const ownershipImmutabilityExtension = Prisma.defineExtension((client) => {
  return client.$extends({
    name: "ownershipImmutability",
      query: {
        $allModels: {
          async findMany({ model, args, query }) {
            // Only inject soft-delete filter for models that actually have `deletedAt`
            if (hasSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: Prisma.DbNull } as any;
            }
            return query(args);
          },
          async findFirst({ model, args, query }) {
            if (hasSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: Prisma.DbNull } as any;
            }
            return query(args);
          },
          async findUnique({ model, args, query }) {
            if (hasSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: Prisma.DbNull } as any;
            }
            return query(args);
          },
        },
      },
  });
});

function hasSoftDelete(model: string): boolean {
  // Only models that actually have a `deletedAt` column in the schema
  // should be filtered here. Currently none implement soft-delete, so
  // this returns false for all models until the schema is updated.
  return false;
}
