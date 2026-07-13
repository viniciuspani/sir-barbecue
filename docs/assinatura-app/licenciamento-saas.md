# Plano — Licenciamento SaaS unificado (assinatura no centro)

> **Status:** aprovado, para execução posterior.
> **Escopo:** backend (Supabase) + enforcement no app mobile. O painel web do dono é planejado à parte.
> **Onde salvar o SQL:** o script `SUPABASE_SCHEMA_LICENSING.sql` gerado na execução mora nesta mesma pasta (`docs/assinatura-app/`).

## Contexto

Hoje existe apenas um **gate de trial de 7 dias** (Opção 1), device-based e sem vínculo com empresa:
- [src/services/trial.ts](../../src/services/trial.ts), [src/store/trialStore.ts](../../src/store/trialStore.ts),
  [src/ui/TrialExpired.tsx](../../src/ui/TrialExpired.tsx), wiring em [app/_layout.tsx](../../app/_layout.tsx).

A necessidade cresceu para um **sistema de licenciamento SaaS**. Em vez de 4 mecanismos separados,
o desenho é **uma coisa só: a ASSINATURA da empresa**. O trial é apenas o **primeiro estado** dessa
assinatura. Quando o potencial cliente instala o build `preview` e **faz o cadastro**, o bootstrap já:
(1) cria a empresa (`tenant`), (2) cria a assinatura com `status='trial'` (7 dias) e
(3) **vincula o `deviceId` do aparelho àquela empresa**. Do trial ao pago é o mesmo modelo — muda só o
`status`. Assim o "deviceId ligado à empresa" e o "bloqueio por pagamento/on-off" caem no mesmo lugar.

**Decisões fechadas com o usuário:**
- Painel do dono = **app web separado**, no **MESMO projeto Supabase do sir-barbecue** (não consome novo
  banco; é outro cliente da mesma URL+anon key; RLS separa super-admin de cliente comum).
- Pagamento = **controle manual** (sem gateway).
- Bloqueio no app = **verificação na abertura + foreground/periódica**, com cache seguro offline (sem Realtime).
- **Trial vincula o device à empresa do cadastro** (não há mais device "sem empresa").

---

## A ideia única: gate de acesso dirigido pela assinatura da empresa

Fluxo de ponta a ponta, um só caminho:

```
Instala (preview OU produção)
  → tela de login/cadastro (sempre acessível)
  → cadastro: cria tenant + subscription(status='trial', trial_ends_at=now+7d) + vincula device→tenant
  → uso normal enquanto get_access_status() = allowed
  → bloqueio (AccessBlocked) quando: trial venceu | past_due | canceled | blocked_by_owner
  → você (dono) muda status/aperta on-off no painel web → próximo check libera/bloqueia
```

Não há mais ramificação por canal nem tabela de trial separada: **todo tenant tem 1 assinatura** e o
mesmo RPC decide o acesso em qualquer build. (Mantém-se só um bypass de dev.)

### 1) Backend — mesmo projeto Supabase

Novo `docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql` (idempotente, no padrão do
[schema atual](../banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql): SECURITY DEFINER + RLS +
trigger `updated_at`):

- `platform_admins (user_id pk)` — o dono da aplicação (você). Semeado via SQL.
- `subscriptions` — **1 por tenant**: `status` (`trial|active|past_due|canceled`),
  `trial_ends_at`, `current_period_end`, `plan`, `monthly_price`, `payment_method`,
  **`blocked_by_owner boolean`** (kill switch on/off), `notes`.
- `tenant_devices` — `device_id ↔ tenant_id` (+ `platform`, `first_seen_at`, `last_seen_at`, `active`).
- `payments` — recebimentos: `tenant_id`, `amount`, `method`, `paid_at`, `reference_month`, `status`.
- `app_expenses` — suas despesas: `name`, `category`, `amount`, `incurred_at`, `recurring`.

**Helper + RLS** (espelha `is_tenant_owner()`/`user_tenant_ids()` já existentes):
- `is_platform_admin()` SECURITY DEFINER.
- Super-admin lê/escreve tudo (visão cross-tenant) em `subscriptions`, `payments`, `app_expenses`, `platform_admins`.
- Cada empresa **lê só a própria** `subscriptions` (policy por `tenant_id in user_tenant_ids()`); não escreve.
- `tenant_devices` acessado só via RPC (nunca direto).

**Bootstrap** — estender o trigger `handle_new_user()` já existente
([schema:454](../banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql#L454)) para, além de
tenant+membership, inserir `subscriptions(status='trial', trial_ends_at = now()+interval '7 days')`.

**RPCs (o contrato que app e painel consomem):**
- `get_access_status()` → `{ allowed, status, reason, ends_at, days_remaining }` baseado na assinatura do
  tenant do usuário logado. Hora e regra 100% no servidor (`now()`), à prova de relógio.
- `bind_device(p_device_id, p_platform)` (SECURITY DEFINER) → registra/atualiza `tenant_devices` do tenant logado.
- `admin_set_tenant_access(p_tenant_id, p_enabled)` (valida `is_platform_admin`) → liga/desliga
  `blocked_by_owner`. **Backend do botão on/off.**
- `admin_list_tenants_overview()` / `admin_finance_summary()` — leitura para o painel (clientes, status,
  device, último pagamento; receita×despesa×lucro).

### 2) App mobile — enforcement

- Evoluir `src/services/trial.ts` → `src/services/access.ts`: chama `get_access_status()` na **abertura**
  e no `AppState → active` (foreground) + intervalo leve; **fail-closed** (último veredito "bloqueado"
  permanece offline; "liberado" concede janela de graça, ex.: 72h) usando o cache em
  [src/services/secureStorage.ts](../../src/services/secureStorage.ts).
- Após login (`currentTenantId` resolvido em [authStore.ts:57](../../src/store/authStore.ts#L57)), chamar
  `bind_device` com `device_id` do **`expo-application`** (`getAndroidId()` — estável, sobrevive à
  reinstalação). *Adiciona dependência `expo-application`.*
- `src/store/trialStore.ts` → `src/store/accessStore.ts` (`checking | allowed | blocked | disabled` + `reason`).
- `src/ui/TrialExpired.tsx` → `src/ui/AccessBlocked.tsx`, cópia por `reason`
  (`trial_expired | payment_overdue | canceled | blocked_by_owner`).
- [app/_layout.tsx](../../app/_layout.tsx): mesmo ponto de wiring; troca trial→access e dispara `bind_device`
  quando o tenant resolve.

### 3) Painel do dono (passo seguinte, fora deste repo)

App web separado apontando para a MESMA URL/anon key: lista de clientes + status,
**toggle on/off**, lançamento manual de pagamentos, despesas, dashboard receita×despesa×lucro. Este plano
entrega o **backend + contrato de RPCs**; o scaffolding do web é planejado à parte (ver
`docs/assinatura-app/painel-web-dono.md` quando gerado).

---

## Arquivos a criar/alterar

- `docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql` (novo).
- `src/services/access.ts` (evolui de `trial.ts`), `src/store/accessStore.ts` (de `trialStore.ts`),
  `src/ui/AccessBlocked.tsx` (de `TrialExpired.tsx`).
- `app/_layout.tsx` (rewire), `package.json` (+`expo-application`).
- **Reuso:** `supabase` client, `secureStorage`, `authStore.currentTenantId`, padrões
  SECURITY DEFINER/RLS/`handle_new_user`/`update_updated_at_column` do schema, `Button`/tokens do design.

## Verificação

1. **SQL:** rodar o `.sql` 2x (idempotência); tabelas antigas intactas.
2. **Cadastro cria tudo:** novo usuário → existe `tenant` + `subscriptions(status='trial')` + linha em
   `tenant_devices` ligando `device_id` ao `tenant`.
3. **Trial expira:** setar `trial_ends_at` no passado → app mostra `AccessBlocked` (`trial_expired`).
4. **On/off do dono:** `admin_set_tenant_access(tenant,false)` → próximo check/foreground bloqueia
   (`blocked_by_owner`); `true` libera. Usuário comum executando esses RPCs deve **falhar** (RLS).
5. **Isolamento:** cliente lê só a própria `subscriptions`; não lê `payments`/`app_expenses`/outros tenants.
6. **Offline:** avião com cache "bloqueado" → segue bloqueado; "liberado" → concede dentro da graça.
7. `npm run typecheck` e `npm run lint` limpos.

## Fora de escopo (agora)
Gateway/webhooks (manual), Supabase Realtime (poll), scaffolding do app web (contrato primeiro).
