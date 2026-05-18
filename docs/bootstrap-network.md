# Driver Network Bootstrap Runbook

1. Deploy the code containing `MatchingPriorityEngine` and the safe bootstrap changes.
2. Apply any additive migrations with your normal deploy flow.
3. Run `npm run backfill:driver-network` (dry-run by default) and inspect the JSON summary.
4. Run `npm run backfill:driver-network -- --write` only after confirming the dry-run output shows no unexpected changes.
5. Run `npm run bootstrap:network` (dry-run by default) and confirm the JSON summary shows only additive changes — no existing user fields, referral codes, or passenger rows should be overwritten.
6. Run `npm run bootstrap:network -- --write` to persist missing users, regions, vehicles, and referral edges.
7. Verify that existing referral links still resolve and that no real users or passengers were overwritten.
8. Apply `prisma/migrations/20260512170000_add_driver_identifier_uniques/migration.sql` only after validating that `publicSlug` is collision-free for all non-null values.

Safety notes:

- Do not run `prisma migrate reset`.
- Do not run destructive seed logic against a live database.
- Bootstrap is non-destructive by design: it never overwrites `experienceLevel`, `publicSlug`, `phone`, `passwordHash`, or existing `referralCode` values; it only adds missing data.
- Keep `DriverRegion` as the persisted regional source of truth.
- Preserve existing `referralCode` values because old distributed links must continue to work.
- `prisma/migrations/20260518000000_passenger_codes_not_null_future/migration.sql` must NOT be applied until the passenger backfill is verified complete.