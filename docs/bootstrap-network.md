# Driver Network Bootstrap Runbook

1. Deploy the code that contains the additive `Driver` fields and the null-tolerant referral runtime path.
2. Apply the additive migration with your normal deploy flow.
3. Run `npm run backfill:driver-network` first without `--write` and inspect the JSON summary.
4. Run `npm run backfill:driver-network -- --write` only after confirming the dry-run output.
5. Run `npm run bootstrap:network` to upsert the canonical driver network without deleting users, regions, vehicles, or referral edges.
6. Verify that existing referral links still resolve and that no real users or passengers were overwritten.
7. Apply `prisma/migrations/20260512170000_add_driver_identifier_uniques/migration.sql` only after validating that `publicSlug` is collision-free for all non-null values.

Safety notes:

- Do not run `prisma migrate reset`.
- Do not run destructive seed logic against a live database.
- Keep `DriverRegion` as the persisted regional source of truth.
- Preserve existing `referralCode` values because old distributed links must continue to work.