# ALIADO — OWNERSHIP RESOLUTION & OWNERSHIP SNAPSHOT

**Documento:** ADR-004 — Ownership Resolution & Ownership Snapshot
**Versão:** 1.0 (Frozen)
**Status:** ✅ Aprovado
**Tipo:** Architectural Decision Record (ADR)
**Depende de:** ADR-001 (Pricing), ADR-002 (Revenue Distribution), ADR-003 (Reward Distribution)

---

## Contexto

A ADR-001 respondeu: **"Quanto custa a corrida?"**

A ADR-002 respondeu: **"Como a receita operacional é distribuída?"**

A ADR-003 respondeu: **"Como os incentivos são distribuídos e rastreados?"**

A ADR-004 responde: **"Quem é o proprietário econômico desta corrida e como essa decisão permanece auditável para sempre?"**

---

## Problema Central

O modelo atual resolve o `rootDriverId` diretamente do campo `passenger.rootDriverId`
no momento do Settlement. Isso funciona, mas não é auditável:

```text
Settlement lê passenger.rootDriverId   ← campo mutável, sem log de resolução
        │
        ▼
Settlement.rootDriverId                ← copiado, mas não rastreável
```

Se o campo `passenger.rootDriverId` mudar por qualquer motivo (migração de rede,
correção de dados, fusão de contas), corridas históricas passam a "pertencer" a
outro owner — sem que nenhum registro indique que isso aconteceu.

---

## 1. Ownership Resolution

**Responsabilidade única:** determinar quem é o proprietário econômico de uma corrida.

O `OwnershipResolver` é a única entidade autorizada a fazer essa determinação.
Nenhum outro serviço (Settlement, Pricing, Reward) resolve ownership diretamente.

### Entradas do Resolver

```text
Passenger.rootDriverId         → fonte primária (MVP)
Driver.referredByDriverId      → herança de rede (futuro)
ReferralRelationship           → hierarquia de múltiplos níveis (futuro)
OperationalZone                → regras geográficas (futuro)
OwnershipPolicy                → regras de negócio configuráveis (futuro)
```

### Saída do Resolver

```text
OwnershipResolution {
  ownerId:        String | null
  ownerType:      OwnerType     (ROOT_DRIVER | CORPORATE | FRANCHISE | NONE)
  resolutionSource: String      (ex: "passenger.rootDriverId", "referral_chain_depth_2")
  policyCode:     String | null (política usada na resolução — para auditar)
}
```

### Regras MVP

1. `ownerId = passenger.rootDriverId` (campo direto, sem hierarquia)
2. `ownerType = ROOT_DRIVER` quando `ownerId != null`
3. `ownerType = NONE` quando `ownerId = null` (corrida orgânica)
4. `resolutionSource = "passenger.rootDriverId"`

---

## 2. Ownership Snapshot

Assim como o `PricingSnapshot` congela o preço, o `OwnershipSnapshot` congela
a propriedade econômica **no momento da criação da corrida**.

```text
OwnershipSnapshot
├── id                    String    (UUID)
├── rideId                String    (FK — unique, uma snapshot por corrida)
├── ownerId               String?   (null = corrida orgânica)
├── ownerType             OwnerType
├── ownershipPolicyCode   String?   (política usada na resolução)
├── ownershipPolicyVersion Int?
├── resolutionSource      String    (rastreabilidade: como foi resolvido)
├── resolvedAt            DateTime  (imutável após criação)
└── createdAt             DateTime
```

### Garantias

- Uma corrida tem exatamente um `OwnershipSnapshot` — criado quando a corrida é criada.
- `OwnershipSnapshot` nunca é atualizado após criação.
- Settlement lê o `ownerId` do `OwnershipSnapshot`, nunca do `Passenger` diretamente.

---

## 3. Imutabilidade

Após criado o `OwnershipSnapshot`:

- **Ownership não muda.**
- Mudanças na rede (promoções, migrações, fusões, campanhas) afetam apenas corridas futuras.
- O Settlement permanece consistente mesmo que o grafo de referências evolua.

Mesmo princípio da ADR-001: assim como o `PricingSnapshot` congela o preço,
o `OwnershipSnapshot` congela a propriedade.

---

## 4. O Grafo Como Fonte — Não Como Auditoria

O grafo de referências (`ReferralRelationship`, `Driver.referredByDriverId`,
`Passenger.rootDriverId`) é uma **fonte de resolução**, não uma fonte de auditoria.

Depois que o `OwnershipSnapshot` existe:

- O grafo pode mudar (nós removidos, arestas corrigidas, novos níveis adicionados).
- A corrida permanece consistente com o snapshot que foi criado.
- Auditorias financeiras leem o snapshot, nunca o estado atual do grafo.

---

## 5. Ownership Policy

O modelo de resolução de ownership não está codificado no `OwnershipResolver`.
Está configurado em uma **política de resolução**.

### MVP

```text
OwnershipPolicy {
  code:    "PASSENGER_ROOTDRIVER_DIRECT"
  source:  passenger.rootDriverId
  depth:   1
}
```

### Futuro (sem alteração de código)

```text
OwnershipPolicy {
  code:    "REFERRAL_CHAIN_DEPTH_2"
  source:  referral_chain
  depth:   2
}

OwnershipPolicy {
  code:    "CORPORATE_CONTRACT"
  source:  corporate_agreement
  depth:   0
}

OwnershipPolicy {
  code:    "FRANCHISE_ZONE"
  source:  operational_zone
  depth:   0
}
```

A troca de política de resolução ocorre via configuração de dados, sem deploy de código.

---

## 6. Integração com RevenuePolicy

Ownership determina o contexto. RevenuePolicy determina a distribuição.
Os dois domínios permanecem desacoplados.

```text
OwnershipSnapshot
        │
        ▼
RevenuePolicyResolver          ← seleciona a política com base no ownerType e ownershipPolicyCode
        │
        ▼
RevenuePolicy
        │
        ▼
RevenueSplitService
```

No MVP, `RevenuePolicyResolver` retorna sempre `ROOT_DRIVER_STANDARD` quando
`ownerType = ROOT_DRIVER`. No futuro, o resolver poderá selecionar políticas
diferentes por tipo de owner (franquia, corporate, campanha).

---

## 7. Auditabilidade Completa

Toda corrida deve permitir reconstruir a cadeia econômica completa
**sem depender do estado atual do banco**:

```text
Ride
        │
        ▼
OwnershipSnapshot     ← quem é o dono e como foi resolvido
        │
        ▼
PricingSnapshot       ← quanto custou
        │
        ▼
RevenuePolicy         ← qual política foi aplicada
        │
        ▼
Settlement            ← como a receita foi distribuída (revenuePolicyId gravado)
        │
        ▼
RewardEvents          ← quais incentivos foram distribuídos (settlementId gravado)
```

Cada snapshot é imutável. Cada referência é uma FK para o registro que estava ativo
no momento da transação. Nenhuma consulta precisa reconstruir o estado — o estado
foi gravado no momento certo.

---

## 8. Pipeline de Criação de Corrida (Settlement V2 → Ownership V1)

```text
[Passenger solicita corrida]
        │
        ▼
OwnershipResolver.resolve(passengerId, rideDate)
        │
        ▼
OwnershipSnapshot criado e persistido    ← imutável daqui em diante
        │
        ▼
PricingEngine.calculate(...)
        │
        ▼
PricingSnapshot persistido               ← imutável daqui em diante
        │
        ▼
[Corrida executada]
        │
        ▼
PaymentIntent confirmado
        │
        ▼
SettlementService
        ├── lê OwnershipSnapshot (não lê Passenger diretamente)
        ├── resolve RevenuePolicy via RevenuePolicyResolver
        ├── chama ValidationGate
        └── persiste Settlement + RevenueSplits
```

---

## 9. Invariantes do Domínio de Ownership

| Invariante | Descrição |
| ---------- | --------- |
| IO-1 | Cada corrida tem exatamente um `OwnershipSnapshot` |
| IO-2 | `OwnershipSnapshot` nunca é atualizado após criação |
| IO-3 | Settlement lê `ownerId` do `OwnershipSnapshot`, nunca do `Passenger` diretamente |
| IO-4 | `OwnershipResolver` é o único serviço autorizado a determinar ownership |
| IO-5 | `ownerId = null` é estado válido (corrida orgânica — `ownerType = NONE`) |
| IO-6 | Mudanças no grafo de referências não afetam snapshots já criados |
| IO-7 | `resolutionSource` identifica exatamente qual campo ou política foi usado |

---

## 10. Ordem Oficial de Implementação (Ownership V1)

```text
1. Enum OwnerType (ROOT_DRIVER | CORPORATE | FRANCHISE | NONE)
2. Model OwnershipSnapshot no schema (ADD ONLY)
3. Migration + seed OwnershipPolicy "PASSENGER_ROOTDRIVER_DIRECT"
4. OwnershipResolver (função pura — resolve a partir do passengerId)
5. Criar OwnershipSnapshot no momento da criação da corrida (RideController / CreateRideUseCase)
6. SettlementService: ler ownerId do OwnershipSnapshot (não de passenger.rootDriverId)
7. Testes: IO-1..IO-7 como suite tests/architecture/ownership.invariants.spec.ts
8. Remover leitura direta de passenger.rootDriverId no Settlement (deprecated)
```

---

## 11. Compatibilidade com Produção

Toda implementação respeita a política de migração incremental da ADR-001 §11.

Corridas históricas **sem** `OwnershipSnapshot`:
- O Settlement continua lendo `passenger.rootDriverId` como fallback (durante a transição).
- Após a transição completa, o fallback é removido (step 8 da implementação).
- `OwnershipSnapshot` é entidade nova — sem breaking change no schema existente.

---

**ADR-004 — Ownership Resolution & Ownership Snapshot**
Versão: 1.0 | Status: Frozen | Aprovado para implementação
Pré-requisitos: ADR-001 ✅ ADR-002 ✅ ADR-003 ✅
