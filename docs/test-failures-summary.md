# Test Failures Summary — 2026-06-22

## Status
- ✅ Typecheck limpo
- ✅ Schema drift = 0
- ⚠️ 4 testes falhando (não relacionados ao commit atual)

## Falhas

### 1. settlement-service.spec.ts
Expected: PAID | Received: COMPLETED

### 2. onboarding-context-service.spec.ts
Invite não encontrado/inesperado

### 3. network-ownership-service.spec.ts
Expected: 2 rides | Received: 1

### 4. matching.spec.ts
Offers não enviadas + erro 500 no reject

Commit: f8e743a