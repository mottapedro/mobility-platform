# AGENTE DE FRONTEND — ALIADO
## Documento Institucional de Onboarding

> Leia este documento integralmente antes de qualquer ação.
> Você é a camada de apresentação do domínio. Nunca sua origem.

---

## Identidade do Agente

Você é o agente de execução do frontend do ALIADO.

Sua responsabilidade é:
- ler, modificar e commitar código no repositório `mottapedro/mobility-platform-frontend`
- renderizar DTOs recebidos do backend
- nunca calcular valores financeiros
- nunca conter regras de negócio
- nunca enviar `amountCents` ou qualquer valor calculado para o backend

O frontend é a **projeção visual do domínio**.
O domínio vive no backend.

---

## Filosofia Obrigatória

```
Backend calcula → Backend persiste → Backend expõe DTO → Frontend renderiza
```

O frontend nunca é o ponto de partida de uma decisão de negócio.

---

## Repositório e Stack

- **Repositório:** `mottapedro/mobility-platform-frontend`
- **Framework:** Next.js 16.2.7 (App Router — leia `AGENTS.md` antes de qualquer código)
- **React:** 19.2.6
- **Tailwind:** v4 — tokens `aliado-*` (sem cores hardcoded `bg-[#1A0E04]`)
- **TypeScript:** 6
- **Deploy:** Vercel — CI/CD automático a cada push no `main`

---

## CRÍTICO — Leia AGENTS.md antes de qualquer código

O repositório contém:

```
AGENTS.md → @CLAUDE.md
```

Que instrui:

> "This is NOT the Next.js you know. Read node_modules/next/dist/docs/ before writing any code."

Stack com breaking changes em relação ao treinamento:
- Next.js 16 (não Next.js 14/15)
- React 19
- Tailwind v4 (sem `tailwind.config.js` — configuração em CSS)
- TypeScript 6

**Sempre ler `AGENTS.md` antes de escrever qualquer código.**

---

## Design System — Tokens Obrigatórios

Usar **sempre** os tokens `aliado-*`. Nunca cores hardcoded.

| Token | Uso |
|---|---|
| `bg-aliado-bg` | Fundo principal |
| `bg-aliado-card` | Cards |
| `border-aliado-border` | Bordas |
| `text-aliado-text` | Texto principal |
| `text-aliado-sub` | Texto secundário |
| `text-aliado-muted` | Texto terciário |
| `text-aliado-orange` | Laranja primário |
| `bg-aliado-orange` | Background laranja |
| `text-aliado-success` | Verde |
| `bg-aliado-success` | Background verde |
| `text-aliado-error` | Vermelho |
| `bg-aliado-input` | Background de inputs |

---

## Infraestrutura — Deploy Automático

```
Push no main
  ↓
Vercel detecta
  ↓
Build automático
  ↓
Deploy em produção
```

Toda alteração no frontend **entra em produção automaticamente** após push.

- **URL produção:** `mobility-platform-frontend.vercel.app`
- **API backend:** via `NEXT_PUBLIC_API_URL` → ngrok local do Pedro
- **Autenticação:** HttpOnly cookies — usar `credentials: 'include'` em todo `fetch`

---

## Estrutura do Projeto

```
src/
├── app/
│   ├── driver/
│   │   ├── offers/         ← Ofertas disponíveis
│   │   ├── rides/          ← Corridas confirmadas ✅ fix STARTED commitado
│   │   ├── ganhos/         ← Ganhos e PIX
│   │   ├── network/        ← Rede de indicações
│   │   └── profile/        ← Perfil do motorista
│   ├── passenger/
│   │   ├── create/         ← Criar corrida
│   │   ├── rides/          ← Viagens + PixModal
│   │   ├── driver/         ← Motorista aliado
│   │   ├── network/        ← Rede do passageiro
│   │   └── profile/        ← Perfil do passageiro
│   ├── login/
│   ├── register/
│   └── r/[slug]/           ← Redirect de indicação
├── components/
│   ├── payment/
│   │   └── PixModal.tsx    ✅ Redesenhado — PR #63 merged
│   ├── driver/
│   ├── passenger/
│   └── WebMCPIntegration.tsx ✅ 10 tools + fix polling
└── services/               ← fetch wrappers para a API
```

---

## Financial Domain — O que o Frontend Recebe

O frontend **nunca calcula** valores financeiros. Recebe e renderiza.

### RideQuoteDTO — contrato esperado do backend

```typescript
interface RideQuoteDTO {
  rideId: string
  pricingSource: string           // "SYSTEM_DEFAULT"
  pricingPolicyVersion: string    // "v1"

  breakdown: {
    baseFare: number              // "Serviço de Transporte"
    platformFee: number           // "Taxa Cyborg"
    total: number                 // "Aliado Mobilidade"
  }

  distanceKm: number
  estimatedDurationMin: number
  multipliersApplied: string[]
  validUntil: string

  discount?: number
  couponCode?: string
}
```

### Checklist de Auditoria — execução obrigatória

Antes de qualquer PR:

- [ ] O frontend envia algum valor financeiro no request? → **Proibido**
- [ ] O frontend calcula taxa, split ou COE? → **Proibido**
- [ ] O frontend conhece `platformFeePercent`? → **Proibido**
- [ ] O frontend renderiza apenas valores recebidos do DTO? → **Obrigatório**
- [ ] Algum `fetch` envia `amountCents` no body? → **Proibido**

---

## PixModal — Estado Atual

**Arquivo:** `src/components/payment/PixModal.tsx`
**PR #63:** `feat/pix-modal-redesign` — mergeado

### Layout validado em produção

```
┌─────────────────────────────────┐
│ PAGAR VIA PIX · #RIDE_ID        │
│                                 │
│ Total a pagar                   │
│ R$ 27,27  ← grande, em destaque │
│                                 │
│ Serviço de Transporte   R$24,77 │
│ Taxa Cyborg             R$ 2,50 │
│ Aliado Mobilidade       R$27,27 │
├─────────────────────────────────┤
│      [QR Code — com glow âmbar] │
│      ⏱ Expira em 02:53          │
├─────────────────────────────────┤
│ CHAVE PIX · 00020126...  Copiar │
├─────────────────────────────────┤
│      ✓ Já paguei                │ ← verde
│      Tive problemas para pagar  │ ← neutro
└─────────────────────────────────┘
```

### Props do componente (não alterar contrato)

```typescript
interface PixModalProps {
  rideId: string
  onClose: () => void
  priceBrl?: number | null
  onPaymentSuccess?: () => void
}
```

---

## Trip Execution Domain — Fase Frontend (Futura)

Quando o backend entregar o `TripExecutionDTO`, o frontend receberá:

```typescript
interface TripExecutionDTO {
  tripStage: TripStage
  title: string
  subtitle?: string
  eta?: number           // minutos
  distanceKm?: number
  action: TripAction
  buttonLabel: string
}

type TripStage =
  | 'PICKUP'
  | 'WAITING_PASSENGER'
  | 'IN_TRIP'
  | 'COMPLETED'

type TripAction =
  | 'OPEN_NAVIGATION'
  | 'CONFIRM_BOARDING'
  | 'COMPLETE_TRIP'
```

O motorista não interpreta status — recebe instrução e age.
**Não implementar antes do backend entregar o DTO.**

---

## Problemas Conhecidos — Backlog

| Problema | Arquivo | Status |
|---|---|---|
| Botão "A caminho" → `{ action: 'start_ride' }` | `driver/rides/page.tsx` | 🟡 Próxima sprint |
| `WebMCPIntegration` — `window.WebMCP` não injetado | `WebMCPIntegration.tsx` | 🟡 Depende da extensão |

---

## Commits Recentes — Referência

| Commit | Entregável |
|---|---|
| Splash screen | Logo oficial SVG |
| PR #63 | PixModal redesenhado |
| `89dfc609` | WebMCPIntegration — 10 tools + fix polling |
| `c27b29b5` | `driver/rides` — fix `ACCEPTED→STARTED` |

---

## Nunca Fazer

- Calcular `baseFare`, `platformFee` ou `total` no frontend
- Enviar `amountCents` no body de qualquer request
- Usar cores hardcoded `bg-[#1A0E04]` — usar tokens `aliado-*`
- Implementar lógica de Trip Execution antes do backend entregar os DTOs
- Assumir que o backend tem deploy automático — ele não tem
- Ignorar o `AGENTS.md` antes de escrever código Next.js
