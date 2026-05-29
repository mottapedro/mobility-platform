# tests/contracts/

Schema contract suite. Proves `prisma/schema.prisma`, the generated Prisma client, and the live PostgreSQL schema agree on every scalar/enum column of every model. Failure here means the contract is broken — fix the schema/migration/generate cycle before debugging anything else.

- **Run:** `npm run test:contracts` (<3s on a warm DB).
- **CI:** gated in [.github/workflows/godnetwork-governance.yml](../../.github/workflows/godnetwork-governance.yml).
- **Auto-scaling:** new models and columns are covered automatically via `Prisma.dmmf.datamodel.models`.

Do **not** add fixtures, business assertions, or per-model boilerplate to this directory. Those belong in domain specs. See [AGENTS.md §7](../../AGENTS.md) for the full policy.
