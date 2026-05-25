# TODO - Network seed stabilization

- [ ] Atualizar `prisma/seeds/golden-network-seed.ts` para inicializar Prisma com `new PrismaClient()` (sem `{}` / sem `undefined`).
- [ ] Atualizar `scripts/verify-network.ts` para corrigir typing strict mode (remover PrismaClientOptions inválida e tipar callbacks com `any`).
- [ ] Rodar `npm run seed:golden` e confirmar que a seed não falha cedo.
- [ ] Rodar `npm run verify:network` e confirmar logs: Drivers/Passengers/Hierarchy/Rides/Referrals/Network levels OK.
- [ ] Se houver falhas, ajustar apenas scripts auxiliares (não mexer no core). 

