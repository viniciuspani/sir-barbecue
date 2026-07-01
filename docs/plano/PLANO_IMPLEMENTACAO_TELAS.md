# Plano de Implementação — Sir Barbecue (La Brasa Espetinhos)

> **Gerado em:** 2026-06-17
> **Base:** `docs/design/telas_la_brasa.html`, `docs/arquitetura/*`, `levantamentos-requisitos/sir-barbecue-requisitos.md`
> **Stack alvo:** React Native + Expo SDK 55 (React 19.2 / RN 0.83.1), offline-first, New Architecture obrigatória
> **Status:** EM EXECUÇÃO — Fases **0–5 implementadas** + **migração multi-tenant SaaS aplicada** (ver "Estado atual" abaixo). Próxima: Fase 6 (A11y/QA) + follow-ups de backend.
> **Revisão (19/06/2026):** stack atualizada de SDK 54 → **SDK 55** conforme [ANALISE_IMPACTO_EXPO_SDK_55.html](./ANALISE_IMPACTO_EXPO_SDK_55.html) (veredito: viável). Expo Router v6 → **v7**; New Architecture passa de *default* a **obrigatória**; ajustes de Fase 0/CI incorporados abaixo.
>
> **Atualização (19/06/2026) — Plano B ATIVADO:** o BD local passou de **WatermelonDB → expo-sqlite + Drizzle** (o spike reprovou no build: o plugin do WDB injeta `JSIModulePackage`, removida no RN 0.83/New Arch). Isolado a `src/data/local` + repositório; telas/stores/services inalterados. As menções a "WatermelonDB" abaixo devem ser lidas como **"expo-sqlite + Drizzle"**. Razão no ADR-003 ([01a](../arquitetura/01a_ARQUITETURA_SOFTWARE_VISAO_GERAL.md)).

---

## ✅ Estado atual — onde paramos (checkpoint 23/06/2026)

> Fases 0–3 implementadas + **migração multi-tenant SaaS aplicada** (código), **gate local verde** (`tsc`/`eslint`/`expo export`), e o app **roda em device Android real** (build EAS `preview`).

| Fase | Status | Resumo |
|------|--------|--------|
| **0 — Scaffold & tooling** | ✅ concluída (validada no device) | Projeto Expo SDK 55 in-place; **Plano B** (expo-sqlite + Drizzle) ativado após o WatermelonDB reprovar no build (`JSIModulePackage` removida no RN 0.83); EAS `preview` instalou e abriu no Android. Doc: [FASE_0_ESQUELETO_SCAFFOLD.md](./FASE_0_ESQUELETO_SCAFFOLD.md). |
| **1 — Shell de navegação** | ✅ concluída | Grupos `(auth)`/`(app)`, bottom tabs, **gate de sessão**, placeholders, login dev. |
| **2 — Autenticação** | ✅ implementada · ⏳ falta configurar Supabase | Login e-mail/senha + **Google OAuth (PKCE)**, Criar Conta, Recuperar Senha, Verificação de E-mail + deep links `auth-callback`/`reset-password`. Setup: [FASE_2_SETUP_SUPABASE.md](./FASE_2_SETUP_SUPABASE.md). |
| **3 — Dados & sync** | ✅ implementada (infra) · ⏳ falta rodar o SQL + testar | Schema local (sales/sale_items/sync_checkpoints) + `DrizzleSaleRepository` (transacional); **Sync Engine** (push retry/backoff + idempotência `client_id` + pull catálogo); conectividade (NetInfo) + **OfflineBanner**. |
| **4 — Núcleo operacional** | ✅ implementada (tenant-aware; gate verde) | Produtos + Nova Venda + Estoque + Dashboard. |
| **5 — Fornecedores/Relatórios/Config/Push** | ✅ implementada (cliente; partes server = follow-up) | Mais/Conta · Fornecedores · Minha Empresa · Relatórios (local) · Notificações. |
| **6 — A11y / offline polish / QA** | ⬜ não iniciada | — |

**Backend (Supabase):** gerado o **schema completo** (11 tabelas + RLS + triggers de estoque + seed de categorias + storage) em **[SUPABASE_SCHEMA_COMPLETO.sql](./SUPABASE_SCHEMA_COMPLETO.sql)** (idempotente; substitui o `FASE_3_SUPABASE_SCHEMA.sql`). O Sync Engine já fala o dialeto desse schema (refs por `client_id`, `category_client_id`, payment methods `credit_card`/`debit_card`).

> ⚠️ **Superado pelo multi-tenant:** o schema canônico agora é **[SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql](../banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql)** (RLS por `tenant_id`). O `SUPABASE_SCHEMA_COMPLETO.sql` fica como referência single-user (obsoleto). Ver seção multi-tenant abaixo.

**Pendências para fechar o que já foi feito:**
- [ ] Rodar `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` no Supabase (banco fresh) + **habilitar o Custom Access Token Hook** (`add_tenant_claims`, tipo Postgres).
- [ ] `.env` (local) + **EAS env vars** com URL/anon key; configurar Google OAuth + redirect URLs (`sirbarbecue://auth-callback`, `sirbarbecue://reset-password`).
- [ ] Rebuild (`npm run deploy:preview`) e testar no device: auth (e-mail/Google/reset) + banner offline.

### ✅ Multi-tenant SaaS — ADOTADO e migrado (23/06/2026)
Pivô de **single-user (RLS por `user_id`) → SaaS multi-tenant (RLS por `tenant_id`/empresa)** confirmado e aplicado. Avaliação de impacto: [AVALIACAO_IMPACTO_MULTI_TENANT.html](../banco-multi-cliente/AVALIACAO_IMPACTO_MULTI_TENANT.html). Schema canônico: [SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql](../banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql).

**Decisões:** MVP = **1 empresa por usuário** (o schema suporta multi-empresa + equipe; seletor/convites em fase posterior). Tabelas filhas (sale_items, etc.) normalizadas (RLS via pai).

**Migração de código aplicada** (gate `tsc`/`eslint`/`expo export` verde):
- **`authStore`** carrega a empresa ativa (`currentTenantId`) do claim do JWT (`app_metadata.tenant_ids`) + fallback `tenant_members`.
- **`syncEngine`** envia `tenant_id` no push (products/sales) e filtra o pull pela empresa; `sale_items` herda do pai; `runSync` exige tenant.
- **`signup` + `auth.ts`** coletam **"Nome da empresa"** → `business_name` (trigger `handle_new_user` cria empresa + membership owner).
- **Docs de arquitetura** (01a/01c/02a/02b md+html) com banners multi-tenant; 01c §8.2 reescrita (RLS por `tenant_id`).

**Setup do backend (pré-requisito de runtime):** rodar o SQL multi-tenant (banco fresh) + **habilitar o Custom Access Token Hook** (`add_tenant_claims`, tipo Postgres) + **logout/login** para o JWT trazer o claim.

---

## Context

O projeto é **greenfield**: hoje só existem documentos (`docs/design/telas_la_brasa.html` com 9 telas, `docs/arquitetura/*` e `levantamentos-requisitos/sir-barbecue-requisitos.md` com 28 RFs + 13 RNFs). Não há código ainda.

O objetivo é transformar o design e a arquitetura num app **React Native + Expo SDK 55**, **offline-first**, seguindo a Clean Architecture e as ADRs já decididas (Supabase + WatermelonDB + Zustand). Antes de codar, validei o design contra os 28 requisitos funcionais e identifiquei **telas que faltam para fechar o fluxo** (detalhadas abaixo).

Decisões confirmadas com o usuário:
- **Escopo:** Full-stack offline-first (UI + camada de dados WatermelonDB + Zustand + Supabase Auth/sync).
- **Navegação:** Expo Router v7 (file-based, padrão do SDK 55).
- **Telas faltantes:** incluídas neste plano.

> **Nota sobre versões:** Expo SDK 55 entrega **React Native 0.83.1 + React 19.2** e torna a **New Architecture obrigatória** (a Legacy Architecture foi removida; `newArchEnabled` sai do `app.json`). O pedido "react-native 19" é interpretado como **React 19** (a lib React) — o SDK 55 usa a 19.2. Impacto da migração 54 → 55 detalhado em [ANALISE_IMPACTO_EXPO_SDK_55.html](./ANALISE_IMPACTO_EXPO_SDK_55.html).

---

## Análise de lacunas — Telas do design × Requisitos (RF)

### Telas já desenhadas (9) e RFs que cobrem
| # | Tela | RFs |
|---|------|-----|
| 1 | Splash / Onboarding | entrada do app |
| 2 | Login | RF-01 (parcial), RF-02 |
| 3 | Dashboard | RF-27, RF-28 |
| 4 | Registrar Venda (Nova Venda) | RF-12, RF-13, RF-14, RF-15 |
| 5 | Fechar Venda (sheet) | RF-12, RF-13, RF-14 |
| 6 | Produtos (lista) | RF-03, RF-04 |
| 7 | Estoque (lista) | RF-08, RF-10, RF-11 (destaque visual) |
| 8 | Relatórios (lista/geração) | RF-17, RF-18, RF-19, RF-20, RF-21 |
| 9 | Fornecedores (lista) | RF-06 |

### Telas FALTANTES necessárias ao fluxo (a criar)
Cada item abaixo é exigido por um RF e/ou referenciado por um elemento de UI nas telas existentes (botão/seta) que não tem destino.

| Tela faltante | RF / Origem na UI |
|---------------|-------------------|
| **A. Criar Conta (Cadastro)** | RF-01 — botão "Criar conta" no Splash e Login não tem destino |
| **B. Recuperar Senha** | RF-01 — link "Esqueci minha senha" no Login sem destino |
| **C. Verificação de E-mail** | RF-01 — "e-mail deve ser verificado antes de liberar acesso" |
| **D. Form Criar/Editar Produto** | RF-03, RF-04, RF-05 — botão "+" e "✏️" na tela Produtos; inclui preço, categoria, ativo e **dias de visibilidade** |
| **E. Form Criar/Editar Fornecedor** | RF-06, RF-07 — botão "+" em Fornecedores; inclui **produtos fornecidos + preço de compra** |
| **F. Detalhe do Fornecedor** | RF-06, RF-07 — cada card tem seta "›" sem destino |
| **G. Registrar Entrada de Estoque** | RF-09 — botões "Registrar Entrada" e "+ Entrada" sem destino |
| **H. Histórico de Entradas** | RF-09 — "histórico de entradas fica acessível para consulta" |
| **I. Configuração de Alerta de Estoque** | RF-11 — tela dedicada listando produtos com limites + saldo |
| **J. Visualizar Relatório** | RF-23, RF-24, RF-25, RF-26 — botão "Ver"; gráficos + download PDF/HTML |
| **K. Menu "Mais"** | Bottom nav tem 5 abas incl. "Mais (⋯)"; Relatórios e Fornecedores vivem sob "Mais" — falta o hub |
| **L. Perfil / Configurações** | Ícone "👤" no Dashboard; logout, **exclusão de conta (RNF-08/LGPD)**, sessão, acessibilidade |
| **M. Central de Notificações** | Ícone "🔔" no Dashboard; RF-22 (relatório pronto) e RF-11 (estoque baixo) |

Itens menores (não viram tela cheia): **feedback "Venda registrada ✓"** (toast/confirmação, RF-12) e **seed inicial de categorias/produtos** no primeiro acesso (migration do doc de BD).

---

## Stack técnica

| Camada | Tecnologia | Observação |
|--------|-----------|-----------|
| Runtime | Expo SDK 55 / RN 0.83.1 / React 19.2 / TypeScript | New Architecture **obrigatória** (Legacy removida) |
| Navegação | **Expo Router v7** (file-based) | tabs + stacks aninhados; APIs novas (Native Tabs, Stack.Toolbar) opcionais |
| Estado global | **Zustand** | auth, conectividade, sync, carrinho de venda |
| BD local (offline) | **expo-sqlite + Drizzle** (SQLite) | First-party do Expo (New Arch oficial); type-safe; reatividade via `addDatabaseChangeListener`/`useLiveQuery`. *(Plano B — WDB descartado: o plugin injetava `JSIModulePackage`, removida no RN 0.83)* |
| Backend | **Supabase** (`@supabase/supabase-js`) | Auth, REST (PostgREST), Realtime, Storage |
| Tokens seguros | `expo-secure-store` | JWT no Keychain/Keystore (RNF-07) |
| Push | `expo-notifications` | FCM/APNs (RF-11, RF-22) |
| Conectividade | `@react-native-community/netinfo` | detectar online/offline (RF-15/16) |
| Sheets/anim | `react-native-reanimated` v4 (+ `react-native-worklets`), `react-native-gesture-handler`, `@gorhom/bottom-sheet` v5 | tela 5 (Fechar Venda); v4/v5 já assumem New Arch |
| Gráficos | `react-native-gifted-charts` (ou `victory-native`) | Dashboard e Visualizar Relatório (RF-26) |
| Visualizar PDF | `react-native-webview` (HTML) + download via `expo-file-system` (**nova API `File`/`Directory`**) / `expo-sharing` | RF-23/24/25 |
| Qualidade | ESLint + Prettier + TypeScript strict; testes com Jest + React Native Testing Library | RNF-12 |

---

## Estrutura de pastas (Clean Architecture)

```
app/                      # Rotas Expo Router (Presentation)
  _layout.tsx             # provider raiz (theme, stores, gesture-handler)
  index.tsx               # Splash → redireciona p/ auth ou app
  (auth)/
    login.tsx  signup.tsx  forgot-password.tsx  verify-email.tsx
  (app)/
    _layout.tsx           # Bottom Tabs (Início, Venda, Produtos, Estoque, Mais)
    index.tsx             # Dashboard (3)
    venda/index.tsx       # Nova Venda (4) — apresentada modal
    venda/fechar.tsx      # Fechar Venda (5) — bottom sheet
    produtos/index.tsx    # Lista (6)
    produtos/[id].tsx     # Form criar/editar (D)
    estoque/index.tsx     # Lista (7)
    estoque/entrada.tsx   # Registrar entrada (G) + histórico (H)
    estoque/alertas.tsx   # Config de alerta (I)
    mais/index.tsx        # Hub "Mais" (K)
    mais/relatorios/index.tsx     # Lista/geração (8)
    mais/relatorios/[id].tsx      # Visualizar relatório (J)
    mais/fornecedores/index.tsx   # Lista (9)
    mais/fornecedores/[id].tsx    # Detalhe + form (E, F)
    mais/perfil.tsx       # Perfil/Config (L)
    notificacoes.tsx      # Central de notificações (M)
src/
  design/        # tokens.ts (porta do CSS), theme.ts, typography
  ui/            # componentes reutilizáveis (Button, Input, Card, Chip, Badge, Toggle, ProgressBar, BottomNavItem, ScreenHeader, EmptyState, Sheet)
  domain/        # entities/, usecases/, repositories/ (interfaces) — TS puro
  data/
    local/       # expo-sqlite + Drizzle: schema.ts, database.ts (+ drizzle-kit migrations)
    remote/      # supabaseClient.ts, DTOs, mappers
    repositories/# implementações (Product, Sale, Stock, Supplier, Report)
    sync/        # syncEngine.ts, offlineQueue.ts (RF-16, retry/backoff)
  store/         # zustand: authStore, connectivityStore, syncStore, cartStore
  services/      # notifications.ts, secureStorage.ts, netinfo.ts
  lib/           # currency (R$), dates (pt-BR), a11y helpers, weekday
```

Mapeamento das **11 tabelas** do doc de BD (`02a`) para models do WatermelonDB: `categories, products, product_day_visibility, suppliers, product_suppliers, stock_items, stock_entries, sales, sale_items, reports` (+ `sync_checkpoints` opcional). `client_id` + `synced_at`/`needs_sync` para idempotência do sync (conforme `02b §8`).

---

## Design system (porta do HTML)

Extrair os tokens do `:root` de `docs/design/telas_la_brasa.html` para `src/design/tokens.ts`:
- Cores: `bg #1A1A1A`, `gold #D4A017`, `red #8B1E1E`, `surface #252525`, `green/yellow/divider`, texto primário/secundário.
- Tipografia **Inter** (via `expo-font` / `@expo-google-fonts/inter`), escala respeitando RNF-05 (corpo ≥16sp, ações ≥18sp).
- Componentes base catalogados a partir das classes `.btn`, `.input-field`, `.card`, `.chip`, `.badge`, `.toggle`, `.progress-bar`, `.bottom-nav` — reusados em todas as telas.
- A11y desde o início: `accessibilityLabel/Role`, alvos de toque ≥48dp, contraste AA (RNF-05).

---

## Fases de entrega (alinhadas às fases do doc de requisitos)

**Fase 0 — Scaffold & tooling** — ✅ **CONCLUÍDA** (validada no device)
- `create-expo-app` (**SDK 55**, TS), ESLint/Prettier, estrutura de pastas, `app.json` (**remover `newArchEnabled`/`sdkVersion`/`statusBar`/`notification`/`edgeToEdgeEnabled`**; notifications via config plugin; edge-to-edge tratado por código).
- Instalar deps via `expo install`; **spike WatermelonDB** (config plugin + `expo prebuild` + dev client em **device físico** iOS+Android — *gate de decisão*: JSI + transação ACID + sync). `@sentry/react-native` **≥ 7.3.0** (bug Gradle 9 no EAS Android). Promise rejections agora viram erro → `try/catch` disciplinado.
- Design tokens + fontes + tema; componentes UI base.

**Fase 1 — Shell de navegação** — ✅ **CONCLUÍDA**
- Tabs (Início, Venda, Produtos, Estoque, Mais) + stacks aninhados; aba "Venda" abre modal; aba "Mais" abre hub.
- Splash (1) com gate de sessão.

**Fase 2 — Autenticação (MVP)** — RF-01, RF-02, RNF-07 — ✅ **IMPLEMENTADA** (⏳ falta configurar Supabase + testar no device)
- Supabase Auth (email/senha + Google OAuth via `expo-auth-session`/`expo-web-browser`).
- Telas: Login (2), **Criar Conta (A)**, **Recuperar Senha (B)**, **Verificação de E-mail (C)**.
- Tokens em `expo-secure-store`; `authStore`.

**Fase 3 — Camada de dados & sync** — RF-15, RF-16, RNF-09 — ✅ **IMPLEMENTADA** (infra; ⏳ falta rodar o SQL no Supabase + testar no device)
- Schema WatermelonDB + models + repositórios (Repository Pattern).
- Sync Engine + offline queue (retry backoff 1/2/4s, `client_id` idempotente, client-wins p/ vendas, server-wins p/ catálogo — `02b §7-8`).
- `connectivityStore` (NetInfo) + indicadores visuais offline/online (presentes nas telas 3 e 4).

**Fase 4 — Núcleo operacional** — ✅ **IMPLEMENTADA** (23/06/2026; gate `tsc`/`eslint`/`expo export` verde; tenant-aware — `tenant_id` injetado pela camada de sync)
- **Produtos** ✅: lista (6) + **form criar/editar (D)** com categorias e **dias de visibilidade (RF-05)**. Stack `app/(app)/produtos/`.
- **Vendas** ✅: Nova Venda (4) com filtro por categoria + visibilidade do dia + carrinho (`cartStore`); Fechar Venda (5) com pagamento/consumo; gravação local transacional + **baixa de estoque (RF-10)** + toast. Stack `app/(app)/venda/`.
- **Estoque** ✅: lista (7) + **Registrar Entrada (G)** + **Histórico (H)** + **Config de Alerta (I)**. Stack `app/(app)/estoque/`. Saldo calculado localmente.
- **Dashboard** ✅: cards do mês (faturamento/contagem), vendas por forma de pagamento, alertas de estoque (queries locais reativas + pull-to-refresh — RF-28).

**Catálogo (decisão — Opção A):** servidor é dono das categorias (trigger `seed_tenant_categories`); o app faz `pullCategories` no sync e **não** semeia categorias localmente.

**Follow-ups da Fase 4 (sync, ao ligar o backend):**
- **Sync de estoque** ✅ (24/06): push de `stock_entries` + `alert_threshold`; pull de `stock_items` (server-wins na quantidade, preservando o alerta local). O servidor recalcula via triggers — isso **ativa o RF-11** (push de estoque baixo).
- **`product_day_visibility`** ⏳ (deferido): a visibilidade por dia segue **local** (JSON em `products.visible_days`), usada no filtro da Nova Venda. Sincronizar com a tabela normalizada do servidor é follow-up (uso local + sync set-based).

**Fase 5 — Fornecedores, Relatórios, Config, Push** — ✅ **IMPLEMENTADA (cliente)** (23/06/2026; gate `tsc`/`eslint`/`expo export` verde; stack `app/(app)/mais/`)
- **Mais (K) + Conta (L)** ✅: hub de navegação; **logout** funcional; **excluir conta** = confirmação + aviso (RNF-08 exige Edge Function server-side).
- **Fornecedores (9/F/E)** ✅: lista + form + detalhe com **associação produto↔fornecedor e preço de compra (RF-07)**. Local-first.
- **Minha Empresa** ✅ (multi-tenant, online): ver/editar dados da empresa (owner-only via RLS) + listar/remover membros (`tenant_members`). **Convidar por e-mail = follow-up** (Edge Function de convite).
- **Relatórios (8)** ✅ (local): resumos por período (faturamento, mais vendidos, por pagamento). **Export PDF/HTML + gráficos (RF-21/24/25/26) = follow-up** (Edge Function `generate-report`).
- **Notificações (M)** ✅ (cliente): permissão + registro de token + explicação. **Envio de push = follow-up** (dev build + FCM + backend disparando — RF-11/22).

**Follow-ups de backend da Fase 5 — STATUS:** Edge Functions (`generate-report`, `invite-member`, `delete-account`, `send-push`) ✅ criadas + ligadas no app; **infra de push** (`push_tokens` + trigger `notify_low_stock` via pg_net) ✅; **sync de fornecedores** (`suppliers`/`product_suppliers`) ✅ e **de estoque** ✅. Resta: `product_day_visibility` (deferido) e, opcionalmente, push de "relatório pronto" (RF-22).

**Fase 6 — Acessibilidade, offline polish & QA** — ⬜ **NÃO INICIADA**
- Auditoria RNF-05 (VoiceOver/TalkBack, fontes, contraste, alvos de toque), estados de loading/empty/erro, ≤5 toques por venda (RNF-03).
- Testes de use cases (domínio) e fluxo de venda offline→sync.

> **Backend Supabase (fora do app, pré-requisito):** schema/migrations (`02a/02b`), RLS, Storage bucket de relatórios e a **Edge Function `generate-report`** precisam ser provisionados em paralelo. Os relatórios são gerados server-side (ADR-004). Posso incluir os scripts SQL/migrations e o esqueleto da Edge Function se desejado.

---

## Verificação (end-to-end)

1. **Build de desenvolvimento** (WatermelonDB exige dev client):
   `npx expo prebuild` → `npx expo run:android` / `run:ios` (ou EAS dev build). Confirmar que o app sobe na New Architecture.
2. **Auth**: criar conta → verificar e-mail → login; login Google; recuperar senha.
3. **Fluxo offline crítico** (RF-15/16): ativar modo avião → registrar venda → ver indicador offline e estoque deduzido localmente → reconectar → ver sync concluído e a venda no Supabase.
4. **Produtos/Estoque**: criar produto com visibilidade de sexta (feijão tropeiro) → confirmar que só aparece na venda na sexta (RF-05); registrar entrada → saldo sobe; baixar abaixo do limite → alerta visual + push (RF-11).
5. **Relatórios**: gerar diário → status "gerando" → push "pronto" → abrir Visualizar com gráficos → baixar PDF (RF-17/21/22/23/24/26).
6. **A11y**: navegar com TalkBack/VoiceOver; checar contraste e alvos de toque (RNF-05).
7. **Testes**: `npm test` (use cases de venda/estoque + serialização da fila offline).

---

## Riscos / pontos a confirmar
- **BD local (RN 0.83.1, New Arch) — RESOLVIDO:** o spike reprovou no build (o plugin de comunidade do WDB injeta `JSIModulePackage`, removida no RN 0.83) → **Plano B ATIVADO**: `expo-sqlite` (first-party) + Drizzle, mantendo as interfaces de repositório (a Clean Architecture isolou a troca a `src/data/local` + repositório). Ver [ANALISE_IMPACTO_EXPO_SDK_55.html](./ANALISE_IMPACTO_EXPO_SDK_55.html).
- **Credenciais Supabase + Google OAuth** (project URL, anon key, client IDs) precisam ser fornecidas para `.env`.
- **Geração de relatórios** depende da Edge Function e do Storage — confirmar se entram neste plano ou em trilha separada de backend.
