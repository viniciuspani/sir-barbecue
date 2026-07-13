# Plano — Painel Web do Dono (Vite + React)

> **Status:** aprovado. Projeto web **separado**, fora do repo mobile (sugestão `c:\develop\WEB\sir-barbecue-admin`).
> **Depende de:** backend de licenciamento (ver [licenciamento-saas.md](./licenciamento-saas.md)) — RPCs `admin_*`, `is_platform_admin`, tabelas `subscriptions`/`tenant_devices`/`payments`/`app_expenses`.

## Contexto

O sistema de licenciamento SaaS entrega o backend no Supabase com o **contrato de RPCs** de administração.
Falta a interface do **dono da aplicação (você)** para operar o negócio: ver clientes, ligar/desligar o
acesso (on/off), lançar pagamentos manuais e acompanhar receita × despesa × lucro.

Este painel é um **app web separado**, no **MESMO projeto Supabase do sir-barbecue** (outro cliente da mesma
URL+anon key; a RLS + `is_platform_admin()` separam super-admin de cliente comum). Não consome banco novo.

**Decisões fechadas com o usuário:**
- Framework = **Vite + React + TypeScript**.
- UI = **Tailwind + shadcn/ui**, herdando o visual do mobile (dark `#1A1A1A` + dourado `#D4A017`, fonte Inter).
- Pagamento = controle manual; bloqueio via toggle on/off (`admin_set_tenant_access`).

### Por que Vite+React e não Angular (registro da decisão)

| Critério | Vite + React ✅ | Angular |
|---|---|---|
| Modelo mental | Igual ao React Native que você já usa (hooks, JSX, zustand) | Framework/paradigma diferente (RxJS, DI, decorators) |
| Curva p/ você | ~zero (reaproveita conhecimento e tokens) | alta (RxJS, módulos, boilerplate) |
| Tamanho do projeto | Ideal p/ painel interno enxuto | Robusto p/ times grandes — overkill aqui |
| Dashboards | TanStack Query/Table + Recharts + shadcn | Angular Material (mais pesado) |
| Velocidade de entrega (solo) | Alta | Menor |

Angular só venceria com time grande/governança enterprise — não é o caso. **React é a escolha certa aqui.**

---

## Stack

- **Vite + React 19 + TypeScript** (alinha com o React 19 do mobile).
- **Tailwind CSS + shadcn/ui** (Radix) — tabela, switch, dialog, cards, badge já no tema escuro.
- **TanStack Query** — estado de servidor/cache das chamadas Supabase.
- **TanStack Table** — lista de clientes com busca/ordenação/filtro.
- **Recharts** — gráficos do financeiro.
- **@supabase/supabase-js** (mesma linha `^2.108` do mobile).
- **React Router** — navegação.
- **Zustand** (leve, opcional) — estado de UI, espelhando o mobile.

**Localização:** projeto separado — `c:\develop\WEB\sir-barbecue-admin` (ajustável).
**Env:** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` = mesmos valores do `EXPO_PUBLIC_*` do mobile
(`.env` fora do git).

## Design — herdar o visual do mobile

- `tailwind.config.ts` com cores portadas de `src/design/tokens.ts` (do mobile):
  `bg #1A1A1A`, `surface #252525`, `gold #D4A017`, `green/yellow/danger`, `divider`, textos; fonte
  **Inter** (Google Fonts); radii/spacing equivalentes.
- Tokens do shadcn (CSS vars) mapeados para essas cores → tema escuro consistente com o app.

## Estrutura e telas

- `src/lib/supabase.ts` — client (storage padrão do browser).
- `src/lib/auth.tsx` — login (Supabase Auth) + **gate super-admin**: após login, checar
  `is_platform_admin()`; se não for admin → signOut + tela "acesso restrito".
- `src/hooks/` — wrappers TanStack Query sobre o contrato de RPCs:
  `useTenantsOverview` (`admin_list_tenants_overview`), `useSetTenantAccess` (`admin_set_tenant_access`),
  `useFinanceSummary` (`admin_finance_summary`), `usePayments`/`useCreatePayment`,
  `useExpenses`/`useCreateExpense` (tables sob RLS super-admin).

**Rotas:**
1. `/login` — autenticação + verificação de super-admin.
2. `/` **Dashboard** — KPIs: clientes ativos / em trial / atrasados, MRR, lucro do mês; mini-gráfico.
3. `/clientes` — **tabela** (TanStack Table): nome, badge de status, device vinculado, fim do período/trial,
   último pagamento, **switch on/off** (`admin_set_tenant_access`). Filtro por status + busca.
4. `/clientes/:tenantId` — detalhe: dados da empresa, assinatura (status/plano/valor/forma pgto/vencimento),
   **dispositivos** (`tenant_devices`, ativar/desativar), **histórico de pagamentos** + "lançar pagamento"
   (insert em `payments`), ações: mudar status / on-off.
5. `/financeiro` — receita (`payments`) × despesa (`app_expenses`) × lucro; gráfico mensal (Recharts);
   **CRUD de despesas**.

## Dependências e ordem

- **Depende do backend de licenciamento**: os RPCs/tabelas precisam existir no Supabase. Durante o dev do
  web dá para construir a UI com dados **mockados** e depois plugar os hooks.
- **Deploy:** build estático (`vite build`) em Vercel/Netlify (free). Segurança = Supabase Auth + gate
  `is_platform_admin` + **RLS** (site público → segurança depende 100% da RLS; testar policies).

## Verificação
1. `npm run dev` sobe; `/login` autentica um super-admin → Dashboard carrega KPIs.
2. **Gate:** login de usuário comum (não em `platform_admins`) → bloqueado com "acesso restrito".
3. **On/off:** alternar o switch de um cliente de teste → o app mobile bloqueia/libera no próximo check.
4. **Pagamento:** lançar pagamento → aparece no histórico do cliente e no `/financeiro`.
5. **Despesa:** cadastrar despesa → lucro recalcula no dashboard/financeiro.
6. **Isolamento:** RLS impede usuário comum de ler `payments`/`app_expenses`/outros tenants.
7. `vite build` + `tsc --noEmit` sem erros.

## Fora de escopo (agora)
Gateway de pagamento/webhooks, multi-idioma, papéis administrativos além do super-admin, testes e2e.
