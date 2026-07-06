# Fase 4 — Trip Execution Domain — Checklist de Execução Local

> Execute este checklist quando o ambiente local estiver pronto.
> Backend rodando via Node.js + PostgreSQL via Docker.

---

## Pré-requisitos

- [ ] Backend local rodando no branch `feat/aliado-v2-domain-hardening`
- [ ] Docker com PostgreSQL ativo
- [ ] `git pull origin feat/aliado-v2-domain-hardening` executado

---

## Sequência de execução

### 1. Verificar que o schema está atualizado

```bash
# Deve mostrar os 6 novos campos no model RideRequest
grep -A 10 "Trip Execution Domain" prisma/schema.prisma
```

Esperado:
```
navigationStartedAt  DateTime?
pickupArrivedAt      DateTime?
boardingAt           DateTime?
tripStartedAt        DateTime?
destinationArrivedAt DateTime?
completedAt          DateTime?
```

### 2. Aplicar a migration

```bash
npx prisma migrate deploy
```

Esperado:
```
Applied 1 migration — 20260705000000_add_trip_execution_timestamps
```

### 3. Regenerar o Prisma Client

```bash
npx prisma generate
```

### 4. Verificar TypeScript

```bash
npx tsc --noEmit
```

Esperado: zero erros.

### 5. Rodar a suite de testes

```bash
npm test
```

Esperado: todos os testes passando (novos campos são nullable — sem impacto).

### 6. Reiniciar o servidor

```bash
# Matar o processo atual e reiniciar
npm run dev
# ou
node dist/server.js
```

### 7. Confirmar colunas no banco

```bash
# Via psql ou cliente SQL
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'RideRequest'
  AND column_name IN (
    'navigationStartedAt',
    'pickupArrivedAt',
    'boardingAt',
    'tripStartedAt',
    'destinationArrivedAt',
    'completedAt'
  );
```

Esperado: 6 linhas com `data_type = timestamp without time zone` e `is_nullable = YES`.

---

## Impacto

| Item | Impacto |
|---|---|
| Corridas existentes | Nenhum — todos os campos nullable |
| Endpoints existentes | Nenhum — sem alteração de contratos |
| Frontend | Nenhum — campos não expostos ainda |
| Smoke tests | Nenhum — não dependem desses campos |

---

## Próxima fase após confirmação

Fase 5 — `DomainEventType` + novos eventos do Trip Execution Domain.
