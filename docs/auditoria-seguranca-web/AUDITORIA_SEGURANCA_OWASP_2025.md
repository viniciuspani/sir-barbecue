# Auditoria de Segurança — OWASP Top 10:2025

**Projeto:** `sir-barbecue-web` (PWA mobile-first, React 19 + Vite 8 + Supabase)
**Superfície de backend incluída:** projeto Supabase compartilhado com o app Android (RLS, RPCs via PostgREST, Edge Functions, Storage)
**Data da auditoria:** 30 de agosto de 2026
**Tipo:** auditoria defensiva autorizada, somente leitura de código-fonte

---

## 1. Sumário executivo

O aplicativo web está, no geral, **bem construído do ponto de vista de segurança**: o isolamento entre empresas (multi-tenant) é feito no servidor por Row Level Security e resistiu à análise — não foi encontrado nenhum caminho pelo qual um usuário de uma empresa consiga ler ou gravar dados de outra. As correções da auditoria anterior (julho/2026) continuam aplicadas e **não reapareceram** na superfície web: o convite de membro não permite mais virar dono de empresa alheia, o CORS das funções é restrito a uma lista de origens, e as triggers de estoque validam a empresa do produto. As dependências não têm nenhuma vulnerabilidade conhecida e nenhum segredo foi encontrado no repositório ou no histórico do Git.

Os dois problemas mais relevantes são de natureza diferente. O primeiro: **o site publicado não envia nenhum cabeçalho de segurança** (não há Content-Security-Policy, HSTS, proteção contra enquadramento em iframe etc.), e como a sessão do usuário fica guardada no navegador, qualquer falha futura que permita injetar script na página vira roubo de sessão completo. O segundo: **o bloqueio por assinatura vencida existe apenas na tela** — o servidor sabe dizer se a empresa está bloqueada, mas não recusa as operações; uma empresa com trial expirado ou suspensa pelo dono continua conseguindo vender e consultar dados chamando a API diretamente. Há ainda um conjunto de restrições por papel (funcionário não vê fornecedores, custos, relatórios) que só existem escondendo botão na interface: pela API, um funcionário legítimo da própria empresa consegue ler o preço de compra e todo o histórico de vendas.

| Categoria OWASP 2025 | Status | Severidade máxima |
|---|---|---|
| A01 — Broken Access Control | Parcialmente exposto | Média |
| A02 — Security Misconfiguration | Vulnerável | Alta |
| A03 — Software Supply Chain Failures | Parcialmente exposto | Baixa |
| A04 — Cryptographic Failures | Parcialmente exposto | Baixa |
| A05 — Injection | Parcialmente exposto | Baixa |
| A06 — Insecure Design | Vulnerável | Alta |
| A07 — Authentication Failures | Parcialmente exposto | Baixa |
| A08 — Software or Data Integrity Failures | Não identificado | Informativa |
| A09 — Security Logging and Alerting Failures | Parcialmente exposto | Média |
| A10 — Mishandling of Exceptional Conditions | Parcialmente exposto | Baixa |

**Contagem de achados:** 2 Altas · 5 Médias · 9 Baixas · 2 Informativas (18 no total)

---

## 2. Metodologia e escopo

### O que foi analisado

**Frontend (`c:\develop\WEB\sir-barbecue-web`)** — leitura integral de:

- roteamento e guardas (`src/App.tsx`, `src/app/guards.tsx`, `src/app/AppShell.tsx`);
- camada de autenticação e sessão (`src/data/services/auth.ts`, `src/store/authStore.ts`, `src/data/supabase.ts`, `src/core/services/passwordRecovery.ts`);
- cliente Supabase, repositórios e hooks de consulta (`src/data/repositories/*`, `src/data/queries/*`);
- wrappers de Edge Function e log de erro (`src/data/services/functions.ts`, `src/data/services/errorLog.ts`, `src/core/rules/errors.ts`);
- regras de acesso e RBAC do cliente (`src/core/rules/access.ts`, `src/core/rules/permissions.ts`, `src/lib/usePermissions.ts`);
- armazenamento local (`src/data/storage.ts`, `src/core/ports/storage.ts`, `src/core/services/membership.ts`);
- telas sensíveis (`Conta.tsx`, `Empresa.tsx`, `Relatorios.tsx`, `FecharVenda.tsx`, telas de `auth/`);
- configuração de build e deploy (`vite.config.ts`, `netlify.toml`, `index.html`, `package.json`, `.env`, `.env.example`, `.gitignore`, `DEPLOY.md`, `scripts/`);
- artefato compilado (`dist/sw.js`, `dist/workbox-*.js`) para confirmar o comportamento real do service worker.

**Backend compartilhado (`c:\develop\MOBILE\sir-barbecue`)** — apenas na medida em que é exposto ao cliente web:

- Edge Functions: `delete-account`, `generate-report`, `health`, `health-webhook`, `invite-member`, `send-push`, `send-subscription-reminder`;
- schema e RLS vivos: `docs/banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` e `docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql`;
- migrações aplicadas sobre eles: `MIGRATION_01`…`MIGRATION_09` (banco-multi-cliente) e `MIGRATION_01`…`MIGRATION_04` (assinatura-app);
- `docs/scripts/rbac_policies.sql` (confirmado como consistente com o schema vivo).

Foi confirmado, como pede o enunciado, que `SUPABASE_SCHEMA_SINGLE_USER.sql`, `docs/plano/FASE_3_SUPABASE_SCHEMA.sql` e `docs/plano/SUPABASE_SCHEMA_COMPLETO.sql` são versões antigas (single-tenant, isolamento por `user_id`) e **não foram usados** para tirar conclusões.

### Verificações executadas

- `npm audit --json` em `sir-barbecue-web` (somente leitura; nenhum comando alterou lockfile ou `node_modules`).
- Busca no histórico do Git por segredos commitados: `git log --all --diff-filter=A -- .env`, `git log --all -S "service_role"`, `git log --all -S "eyJ"`, `git ls-files`.
- Busca por padrões perigosos no `src/`: `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`, `window.open`, acesso direto a `localStorage`/`sessionStorage`/`indexedDB`.

### O que ficou de fora

- Código exclusivo do app Android nativo (SQLite/Drizzle local, sync push/pull, permissões do manifesto Android).
- O painel administrativo web (`c:\develop\WEB\sir-barbecue-admin`), projeto separado — só foi considerado onde compartilha superfície (RPCs `admin_*`, `ALLOWED_ORIGIN`).
- Teste dinâmico. **Nenhuma requisição foi feita ao Supabase de produção**; todas as conclusões vêm de leitura de código.

### O que não é verificável só pelo código

O repositório contém os scripts SQL, mas não o **estado real** do banco. As policies aqui analisadas só valem se os scripts foram de fato executados e não foram alterados manualmente depois. O mesmo vale para segredos de Edge Function, configuração de Auth e headers de deploy. A seção 5 lista esses itens como checklist.

---

## 3. Achados por categoria

---

### A01:2025 — Broken Access Control

**Status: Parcialmente exposto** · Severidade máxima: **Média**

O isolamento **entre empresas** está correto e é a parte mais importante deste sistema. Toda tabela de negócio tem RLS habilitada e as policies derivam da função `public.user_tenant_ids()` (`SECURITY DEFINER`, lê `tenant_members` pelo `auth.uid()`), o que impede um usuário de ver linha de outro tenant mesmo forjando o `tenant_id` na requisição. As tabelas filhas normalizadas (`sale_items`, `tab_items`, `product_suppliers`, `product_day_visibility`) isolam via `EXISTS` no pai, o que também é correto. **Não foi encontrado caminho de vazamento cross-tenant.**

O que está exposto é o nível abaixo: as restrições **por papel** (owner / manager / employee) que a interface aplica não têm equivalente no servidor.

---

#### `A01-01` — RBAC de tela (fornecedores, custos, relatórios, vendas) existe só na UI

**Severidade: Média** · Status: **Vulnerável**

**Evidência — o controle no cliente:**

`src/core/rules/permissions.ts:14-26`
```ts
// Acesso a telas (owner e manager; employee fica de fora).
export const canAccessHome = isManagerUp;
export const canAccessProducts = isManagerUp;
export const canAccessStock = isManagerUp;
export const canAccessCompany = isManagerUp;
export const canAccessReports = isManagerUp;
// Fornecedores: só owner/manager veem a tela (employee fica de fora).
export const canAccessSuppliers = isManagerUp;
```

`src/app/guards.tsx:64-73`
```tsx
export function RequireRole({ can, children }: {...}) {
  const permissions = usePermissions();
  if (!permissions[can]) return <Navigate to="/venda" replace />;
  return children ? <>{children}</> : <Outlet />;
}
```

**Evidência — a ausência do controle correspondente no servidor:**

`docs/banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:466-467`
```sql
create policy suppliers_select on public.suppliers for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
```

`…:475-478`
```sql
create policy product_suppliers_select on public.product_suppliers for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and p.tenant_id in (select public.user_tenant_ids())));
```

`…:490-493`
```sql
create policy tenant_select on public.product_supplier_price_history for select to authenticated
  using (exists (select 1 from public.products p
                where p.client_id = product_client_id
                  and p.tenant_id in (select public.user_tenant_ids())));
```

`…:411-418` (vendas — leitura e escrita para todo membro)
```sql
foreach t in array array['sales','sync_checkpoints'] loop
  execute format(
    'create policy tenant_all on public.%I for all to authenticated
       using (tenant_id in (select public.user_tenant_ids()))
       with check (tenant_id in (select public.user_tenant_ids()));', t);
```

O próprio código admite a assimetria — `src/app/guards.tsx:16`: *"Todos são barreira de UI. Quem realmente barra é a RLS do servidor."* O problema é que, para **papel** (diferente de **empresa**), a RLS não barra.

**Por que é explorável.** Um funcionário (`employee`) da empresa faz login normalmente no PWA. Com o navegador aberto no DevTools ele copia o `access_token` do `localStorage` (chave `sb-<ref>-auth-token`) e faz, de qualquer terminal:

```bash
curl "https://<ref>.supabase.co/rest/v1/product_suppliers?select=*" \
  -H "apikey: <anon key, que está no bundle público>" \
  -H "Authorization: Bearer <access_token do próprio funcionário>"
```

A RLS deixa passar: ele é membro da empresa dona daqueles produtos. O mesmo vale para `suppliers` (nome, telefone e endereço de todos os fornecedores), `product_supplier_price_history` (série histórica de preço de compra) e `sales` (histórico completo de faturamento). Nenhum desses dados aparece na interface dele.

**Impacto no negócio.** O preço de compra e a margem são a informação comercial mais sensível de um PDV. Um funcionário de saída — ou aliciado por um concorrente — leva a lista completa de fornecedores com preço negociado e o faturamento histórico do negócio. Não é vazamento entre empresas, mas é vazamento para dentro de uma faixa de confiança que o produto explicitamente prometeu não conceder (a tela de Fornecedores é bloqueada para funcionário justamente por isso).

**Correção recomendada.** Espelhar na RLS a mesma matriz da UI. As policies de leitura de fornecedor/custo passam a exigir `owner|manager`:

```sql
-- suppliers: leitura restrita a owner|manager (escrita já é owner-only)
drop policy if exists suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated
  using (public.is_tenant_owner_or_manager(tenant_id));

-- product_suppliers: idem, via produto pai
drop policy if exists product_suppliers_select on public.product_suppliers;
create policy product_suppliers_select on public.product_suppliers for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and public.is_tenant_owner_or_manager(p.tenant_id)));

-- histórico de preço: idem
drop policy if exists tenant_select on public.product_supplier_price_history;
create policy tenant_select on public.product_supplier_price_history for select to authenticated
  using (exists (select 1 from public.products p
                 where p.client_id = product_client_id
                   and public.is_tenant_owner_or_manager(p.tenant_id)));
```

Para `sales`, é preciso cuidado: o funcionário **precisa** poder inserir venda e o app mobile precisa ler as próprias vendas para sincronizar. Uma separação viável é manter a escrita para todo membro e restringir a **leitura histórica** — por exemplo, funcionário só lê vendas do próprio `user_id` e do dia corrente:

```sql
drop policy if exists tenant_all on public.sales;
create policy sales_write on public.sales for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));
-- e, se quiser limitar leitura histórica ao gestor, trocar a leitura por:
--   using (public.is_tenant_owner_or_manager(tenant_id)
--          or (user_id = auth.uid() and sale_date >= date_trunc('day', now())))
```

> **Atenção:** essa mudança em `sales` afeta o app Android (o pull do sync). Validar contra o mobile antes de aplicar; se o custo for alto, tratar `sales` numa onda posterior e aplicar já a parte de fornecedor/custo, que é o dado mais sensível e não é usado pela venda.

---

#### `A01-02` — `generate-report` não verifica o papel do chamador

**Severidade: Média** · Status: **Vulnerável**

**Evidência:** `supabase/functions/generate-report/index.ts:126-127`
```ts
const caller = await getCallerTenant(req, body.tenant_id ?? null);
if (!caller) return json({ error: 'Não autenticado ou sem acesso à empresa.' }, 401);
```

`getCallerTenant` (linhas 57-82) valida **apenas o vínculo com a empresa**, nunca o papel. Não há checagem de `owner|manager` em nenhum ponto antes do processamento. A função então agrega vendas, produtos e **custos de fornecedor** (linhas 147-171) e sobe o HTML no Storage com o cliente `service_role` (linhas 219-231):

```ts
const admin = adminClient();
const path = `${caller.tenantId}/${reportId}.html`;
const upload = await admin.storage.from('reports').upload(path, ...);
```

Só depois disso vem o `INSERT` em `reports` (linha 233), esse sim com o cliente do usuário e portanto sujeito à policy `reports_access` (`is_tenant_owner_or_manager`).

**Por que é explorável.** Um funcionário chama a função (o wrapper `src/data/services/functions.ts:45-52` está no bundle e não é bloqueado por nada além da tela). A função executa toda a agregação financeira, grava um arquivo HTML no bucket e **só então** falha no `INSERT`, devolvendo erro 400. O funcionário não recebe o `path` e a policy de Storage (`reports_tenant_read`, exige `owner|manager`) impede que ele leia o arquivo — então **não há vazamento direto do relatório**. O que fica é: (a) um funcionário consegue fazer o servidor gastar trabalho e escrever arquivos órfãos no Storage indefinidamente, sem limite nem rotina de limpeza; (b) a autorização depende de um efeito colateral tardio (a policy do `INSERT`), não de uma verificação explícita — qualquer refatoração que troque `u` por `admin` naquela linha transforma isso num vazamento real de dados financeiros.

**Impacto no negócio.** Custo de Storage crescente no plano gratuito do Supabase (que tem ~1 GB) e uma autorização frágil por acidente, num caminho que manipula justamente lucro, margem e custo de fornecedor.

**Correção recomendada.** Checagem explícita de papel logo após resolver o chamador:

```ts
const caller = await getCallerTenant(req, body.tenant_id ?? null);
if (!caller) return json({ error: 'Não autenticado ou sem acesso à empresa.' }, 401);

// Relatório é dado financeiro: só owner|manager.
const { data: me } = await u
  .from('tenant_members').select('role')
  .eq('tenant_id', caller.tenantId).eq('user_id', caller.userId).maybeSingle();
if (!['owner', 'manager'].includes((me as { role?: string } | null)?.role ?? '')) {
  return json({ error: 'Apenas dono ou gerente podem gerar relatórios.' }, 403);
}
```

Complementarmente, mover o `upload` para **depois** do `INSERT` bem-sucedido, para que uma falha de autorização nunca deixe arquivo no bucket.

---

#### `A01-03` — Qualquer membro pode alterar ou apagar vendas e comandas pela API

**Severidade: Baixa** · Status: **Vulnerável**

**Evidência:** `docs/banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:411-426` — a policy de `sales` e `sale_items` é `for all` (SELECT, INSERT, UPDATE **e DELETE**) para qualquer membro da empresa. O mesmo em `docs/banco-multi-cliente/MIGRATION_09_tabs.sql:72-85`:

```sql
create policy tenant_all on public.tabs for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));
```

**Por que é explorável.** O PWA nunca oferece "apagar venda". Mas a API oferece:

```bash
curl -X DELETE "https://<ref>.supabase.co/rest/v1/sales?client_id=eq.<uuid>" \
  -H "apikey: <anon>" -H "Authorization: Bearer <token do funcionário>"
```

O funcionário registra a venda (o cliente vê o valor certo, o estoque baixa), recebe o dinheiro em espécie e depois apaga a linha. O `sale_items` cai por cascade, mas a baixa de estoque **não é revertida** — o estoque continua correto e o faturamento fica menor. É o padrão clássico de sangria de caixa em PDV.

**Impacto no negócio.** Fraude interna difícil de detectar: o dono só percebe pela divergência entre estoque consumido e faturamento registrado, e não há log que aponte quem apagou.

**Correção recomendada.** Venda é registro contábil — deve ser append-only para todos, e cancelamento vira estorno explícito:

```sql
drop policy if exists tenant_all on public.sales;
create policy sales_select on public.sales for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy sales_insert on public.sales for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids()));
-- UPDATE/DELETE: só owner (ou ninguém, com estorno via RPC dedicada)
create policy sales_admin on public.sales for delete to authenticated
  using (public.is_tenant_owner(tenant_id));
```

Aplicar o mesmo raciocínio a `sale_items`. Para `tabs`, o `UPDATE` é legítimo (fechar/descartar comanda), mas o `DELETE` pode ser restrito a owner.

---

#### `A01-04` — `error_logs` aceita `tenant_id` arbitrário no INSERT

**Severidade: Baixa** · Status: **Vulnerável**

**Evidência:** `docs/banco-multi-cliente/MIGRATION_05_error_logs.sql:56-59`
```sql
create policy error_logs_insert on public.error_logs
  for insert to authenticated
  with check (user_id = auth.uid());
```

A policy valida o `user_id` mas **não** o `tenant_id`. O cliente envia a coluna livremente — `src/data/services/errorLog.ts:92-95`:
```ts
const row = {
  client_id: crypto.randomUUID?.() ?? refCode,
  tenant_id: auth.currentTenantId,
  user_id: auth.user.id,
```

**Por que é explorável.** Qualquer usuário autenticado (inclusive um recém-cadastrado, dono apenas da própria empresa) insere linhas em `error_logs` carimbadas com o `tenant_id` de outra empresa. Como a leitura é liberada ao `owner` daquele tenant (`…:71-77`), o conteúdo forjado aparece no painel de erros do dono alheio e no painel do super-admin, com `message`, `action` e `user_message` totalmente controlados pelo atacante.

**Impacto no negócio.** Poluição da trilha de diagnóstico e engenharia social contra o suporte ("registramos um erro, ligue para 0800-falso"). O `tenant_id` não é público, mas vaza para qualquer ex-funcionário. Impacto baixo, correção trivial.

**Correção recomendada.**
```sql
drop policy if exists error_logs_insert on public.error_logs;
create policy error_logs_insert on public.error_logs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (tenant_id is null or tenant_id in (select public.user_tenant_ids()))
  );
```
(o `is null` preserva o caso deliberado de erro antes de haver vínculo com empresa). Aplicar o mesmo `with check` na policy de UPDATE.

---

### A02:2025 — Security Misconfiguration

**Status: Vulnerável** · Severidade máxima: **Alta**

---

#### `A02-01` — Nenhum cabeçalho de segurança no deploy

**Severidade: Alta** · Status: **Vulnerável**

**Evidência:** `netlify.toml` (arquivo completo, 43 linhas). Existem cinco blocos `[[headers]]` — linhas 15, 21, 28, 33 e 39 — e **todos** definem apenas `Cache-Control` (e um `Content-Type`):

```toml
15  [[headers]]
16    for = "/assets/*"
17    [headers.values]
18      Cache-Control = "public, max-age=31536000, immutable"
```

Não há `public/_headers` (verificado: `public/` contém apenas imagens e a pasta `icons/`), e `index.html` não traz `<meta http-equiv="Content-Security-Policy">`. Ou seja, o site é servido **sem**:

| Cabeçalho | Situação |
|---|---|
| `Content-Security-Policy` | ausente |
| `Strict-Transport-Security` | ausente |
| `X-Frame-Options` / `frame-ancestors` | ausente |
| `X-Content-Type-Options` | ausente |
| `Referrer-Policy` | ausente |
| `Permissions-Policy` | ausente |

O agravante é onde a sessão mora — `src/data/supabase.ts:22-33`:
```ts
export const supabase = createClient(url, anonKey, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true, flowType: 'pkce' },
});
```
`persistSession: true` no navegador grava o `access_token` e o `refresh_token` em `localStorage` — acessíveis a qualquer script rodando na origem.

**Por que é explorável.** Dois cenários realistas:

1. **Clickjacking.** Sem `X-Frame-Options`/`frame-ancestors`, um site de terceiros embute `https://<dominio>/` num `<iframe>` transparente sobre um botão isca. O PDV roda em sessão persistida no iPhone do balcão: um toque enganado dispara "Confirmar venda", "Remover membro" ou "Excluir conta" (que só pede um `window.confirm`, ver A06-03).
2. **Amplificação de XSS.** Hoje o SPA está limpo (não há `dangerouslySetInnerHTML`, `innerHTML`, `eval` nem `document.write` em `src/` — verificado). Mas sem CSP, o dia em que uma dependência transitiva ou um trecho novo introduzir injeção, o payload roda com permissão total: lê `localStorage`, extrai o `refresh_token` e o envia para fora. Com `refresh_token` em mãos, o atacante mantém acesso indefinido à empresa mesmo depois de o usuário fechar o app. CSP é exatamente o controle que transforma esse cenário de "comprometimento total" em "script bloqueado".

Também sem HSTS: o primeiro acesso digitado como `http://` fica sujeito a downgrade antes de o Netlify redirecionar.

**Impacto no negócio.** Roubo de sessão significa acesso completo aos dados da empresa comprometida — vendas, estoque, fornecedores, custos — e capacidade de operar como aquele usuário (inclusive excluir a conta e todos os dados, se for o dono). É o achado com maior relação impacto/esforço do relatório: a correção é uma dúzia de linhas em arquivo de configuração.

**Correção recomendada.** Acrescentar ao `netlify.toml`:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests"
    Strict-Transport-Security = "max-age=31536000; includeSubDomains; preload"
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
```

Notas de implementação, verificadas contra o código:

- `connect-src` precisa do domínio Supabase em `https:` **e** `wss:` — a tela de Comandas abre um canal Realtime (`src/data/queries/tabs.ts:44-48`).
- `style-src 'unsafe-inline'` é necessário porque o Tailwind injeta estilo e o `index.html:31-34` carrega Google Fonts. Se quiser eliminar o `'unsafe-inline'`, autohospede as fontes.
- **Não é preciso** afrouxar nada por causa do relatório: ele é renderizado em `<iframe srcDoc sandbox="">` (`src/screens/relatorios/Relatorios.tsx:203-208`), um documento opaco e sem script, coberto por `frame-src 'self'`.
- Depois de publicar, validar com o app instalado no iPhone (standalone) — o service worker e o manifest também passam por essas regras.

---

#### `A02-02` — `send-push` trata `ALLOWED_ORIGIN` de forma diferente das outras funções

**Severidade: Baixa** · Status: **Vulnerável** (configuração inconsistente; falha fechada)

**Evidência:** `supabase/functions/send-push/index.ts:12-17`
```ts
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '';
const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  ...
};
```

As demais funções chamadas do navegador fazem o parse de **lista** e ecoam só a origem que bateu — `invite-member/index.ts:18-32`, `delete-account/index.ts:17-31`, `generate-report/index.ts:14-28`, `health/index.ts:32-46`. E o `DEPLOY.md` instrui a configurar `ALLOWED_ORIGIN` como lista separada por vírgula.

**Por que importa.** Com uma lista no secret, `send-push` devolve `Access-Control-Allow-Origin: https://a,https://b`, valor inválido que **todo** navegador rejeita. Ela também não emite `Vary: Origin`, que as outras emitem justamente para impedir que um cache intermediário sirva a resposta de uma origem para outra. Na prática a função falha fechada (nada é liberado indevidamente), então isto **não é um bypass de CORS** — é uma inconsistência que vira armadilha se alguém "consertar" trocando por `'*'`. Hoje o web nem chama essa função (o push está desabilitado por decisão de produto), o que reduz ainda mais o risco.

**Correção recomendada.** Copiar `corsHeadersFor(req)`/`jsonFor(req)` das outras funções para `send-push`, mantendo `Vary: Origin`.

---

#### `A02-03` — `VITE_ACCESS_BYPASS` desliga o gate de assinatura em tempo de build

**Severidade: Informativa** · Status: **Não identificado** (mitigado por documentação; risco operacional)

**Evidência:** `src/data/services/access.ts:15-18`
```ts
/** Bypass de desenvolvimento: VITE_ACCESS_BYPASS=true desliga o gate. */
export function isAccessEnforced(): boolean {
  return import.meta.env.VITE_ACCESS_BYPASS !== 'true';
}
```
Consumido em `src/store/accessStore.ts:29-32`. O `.env` local traz `VITE_ACCESS_BYPASS=false` (linha 7) e o `.env.example` avisa em maiúsculas: *"NUNCA definir como true em produção"*.

**Por que registrar.** É variável de build do Vite: definida no painel da Netlify, fica compilada no bundle e desliga a tela de bloqueio para **todos** os clientes até o próximo deploy. Não é falha de código, é um pé de ouvido operacional — e, como o gate é apenas de UI (A06-01), ligar essa flag é o caminho mais rápido para transformar um problema Alto em perda de receita imediata.

**Recomendação.** Conferir no painel da Netlify que a variável não está definida (ou está `false`) e, opcionalmente, fazer o build falhar quando `NODE_ENV === 'production' && VITE_ACCESS_BYPASS === 'true'`.

---

### A03:2025 — Software Supply Chain Failures

**Status: Parcialmente exposto** · Severidade máxima: **Baixa**

**`npm audit --json` (executado em 30/08/2026, somente leitura):**

```json
"metadata": { "vulnerabilities": {
  "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": 0 },
  "dependencies": { "prod": 25, "dev": 482, "optional": 103, "total": 506 } }
```

**Zero vulnerabilidades**, em produção e em desenvolvimento. As 9 dependências de produção (`@supabase/supabase-js`, `@tanstack/react-query`, `clsx`, `lucide-react`, `react`, `react-dom`, `react-router-dom`, `tailwind-merge`, `zustand`) são todas de manutenção ativa e amplamente usadas. `sharp` (que puxa binários nativos) é **devDependency**, usada só pelo script `npm run icons` — não entra no bundle.

O `package-lock.json` está commitado, o que garante build reproduzível, e o `netlify.toml:5-6` fixa `NODE_VERSION = "22"`.

---

#### `A03-01` — Edge Functions importam do esm.sh sem versão exata

**Severidade: Baixa** · Status: **Vulnerável**

**Evidência:** todas as seis funções que usam o SDK importam o mesmo especificador flutuante —
`supabase/functions/invite-member/index.ts:8`, `delete-account/index.ts:7`, `generate-report/index.ts:4`, `send-push/index.ts:9`, `health/index.ts:19`, `health-webhook/index.ts:21`:

```ts
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
```

**Por que importa.** `@2` resolve para a última 2.x **no momento do deploy**, sem lockfile, sem `integrity` e sem `import_map` — e sem `deno.lock`, ausente no repositório. Esse código roda com a `SUPABASE_SERVICE_ROLE_KEY` no ambiente (`invite-member/index.ts:44-50`, `delete-account/index.ts:43-49`, `generate-report/index.ts:40-46`). Uma versão maliciosa publicada no registro — ou um comprometimento do esm.sh — executa com privilégio total sobre o banco: leitura e escrita em **todas** as empresas, ignorando RLS. É exatamente o cenário que a categoria A03:2025 descreve.

Não há indício algum de comprometimento hoje; o achado é sobre a **ausência de salvaguarda**, não sobre um pacote ruim.

**Impacto no negócio.** Comprometimento total e simultâneo de todos os clientes do SaaS — o pior caso técnico do sistema, ainda que de baixa probabilidade.

**Correção recomendada.** Fixar versão exata e travar a integridade:

```ts
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
```

e, se o fluxo de deploy permitir sair do "self-contained pelo dashboard", adicionar `supabase/functions/deno.lock` (gerado por `deno cache --lock=deno.lock --lock-write`) ou migrar para `npm:@supabase/supabase-js@2.58.0`, que o runtime das Edge Functions já suporta.

---

### A04:2025 — Cryptographic Failures

**Status: Parcialmente exposto** · Severidade máxima: **Baixa**

**Segredos: nada vazado.** Verificações feitas:

- `.gitignore:6-8` ignora `.env` e `.env.*`, com exceção explícita de `.env.example`.
- `git ls-files | grep env` → só `.env.example` e `src/vite-env.d.ts`. O `.env` **não** está versionado.
- `git log --all --diff-filter=A -- .env` → nenhum resultado. O `.env` nunca foi commitado.
- `git log --all -S "service_role"` → **nenhum resultado**. A `service_role` nunca esteve neste repositório.
- `git log --all -S "eyJ"` → uma única ocorrência (`66c15a5`), inspecionada: são o placeholder `VITE_SUPABASE_ANON_KEY=eyJ...` do `.env.example`, hashes `integrity` do `package-lock.json` e um JWT de exemplo dentro do **teste** do redator (`src/core/rules/errors.test.ts`). Nenhum segredo real.

**Variáveis existentes no `.env` (nomes apenas):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ACCESS_BYPASS`.

A `VITE_SUPABASE_ANON_KEY` é **pública por projeto** — vai no bundle JavaScript por design e é inútil sem uma sessão válida, porque toda tabela tem RLS. **Não é vazamento e não deve ser tratada como tal.** A `service_role` fica só como secret de Edge Function no Supabase, nunca no cliente — confirmado: nenhuma ocorrência de `SERVICE_ROLE` em `sir-barbecue-web/src/`.

Transporte: Netlify serve por HTTPS e o Supabase idem; o único ponto sem TLS forçado é a ausência de HSTS, já contabilizada em A02-01.

---

#### `A04-01` — Sessão persistida em `localStorage`

**Severidade: Baixa** · Status: **Parcialmente exposto** (decisão consciente, documentada)

**Evidência:** `src/data/supabase.ts:14-33`
```ts
/**
 * Diferenças em relação ao cliente do mobile:
 *  - sessão no `localStorage` do navegador (não há Keychain/Keystore aqui);
 */
export const supabase = createClient(url, anonKey, {
  auth: { autoRefreshToken: true, persistSession: true, ... },
});
```

**Análise.** É o comportamento padrão do `supabase-js` no navegador e a alternativa (cookie `HttpOnly` + `SameSite`) exigiria um backend próprio que este projeto deliberadamente não tem. **Não é um achado de implementação errada** — é o registro honesto de que o único controle que protege o token contra script hostil é a CSP, que hoje não existe (A02-01). Corrigir A02-01 resolve a maior parte deste risco.

Ponto positivo relacionado: o `localStorage` é usado com cuidado para o resto — `src/core/rules/access.ts:6-13` documenta a decisão de **não** cachear o veredito de assinatura no web precisamente porque o usuário edita `localStorage` à vontade; e `src/core/services/membership.ts:12` escopa o cache de vínculo por `userId` para não vazar entre contas no mesmo navegador.

---

### A05:2025 — Injection

**Status: Parcialmente exposto** · Severidade máxima: **Baixa**

**SQL Injection: não identificado.** Todo acesso a dados passa por PostgREST (`supabase.from(...)`, que parametriza) ou por RPCs com parâmetros tipados (`create_sale`, `get_access_status`, `has_pending_invite`). Nenhuma concatenação de SQL com entrada do usuário. As funções `plpgsql` que fazem `execute format(...)` (`SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:272-284`, `375-385`, `408-418`) montam DDL a partir de **arrays literais de nomes de tabela escritos no próprio script**, não de entrada externa, e usam `%I`/`%1$s` corretamente.

**XSS no SPA: não identificado.** Busca em todo o `src/` por `dangerouslySetInnerHTML`, `innerHTML`, `eval(`, `new Function`, `document.write` → nenhuma ocorrência. React escapa por padrão e o código não sai desse caminho.

**XSS no relatório: mitigado de forma exemplar.** `src/screens/relatorios/Relatorios.tsx:198-209` renderiza o HTML vindo do Storage em `<iframe srcDoc={reportHtml} sandbox="">` — origem opaca, sem script, sem navegação. Do lado do servidor, `generate-report/index.ts:253-261` tem um `escapeHtml` que cobre `& < > " ' /` e é aplicado em todo dado dinâmico (nome de produto, rótulo, valores), e o próprio documento gerado carrega `default-src 'none'` (linha 396).

---

#### `A05-01` — Injeção de HTML no e-mail de lembrete de assinatura

**Severidade: Baixa** · Status: **Vulnerável**

**Evidência:** `supabase/functions/send-subscription-reminder/index.ts:41-51`
```ts
function buildEmailHtml(tenantName: string, dueDateFormatted: string): string {
  return `
    <p>Olá, ${tenantName}!</p>
    ...
```

`tenantName` não passa por escape. Ele vem de `public.tenants.name` — coluna que o dono da empresa edita livremente pela tela Minha Empresa (`src/data/services/tenant.ts:45-55`) ou define no cadastro via `business_name` (`src/data/services/auth.ts:52`). O caminho completo é `send_subscription_due_reminders()` (`SUPABASE_SCHEMA_LICENSING.sql:410-426`), que passa `t.name` como `tenantName` no corpo do `net.http_post`.

**Por que é explorável (e por que é Baixa).** O destinatário do e-mail é `u.email` do **próprio** `owner_user_id` daquela empresa (`…:411-413`). Ou seja: quem injeta o HTML é quem recebe. Não há caminho para atingir outra empresa nem o operador da plataforma. O que resta é: conteúdo arbitrário sob o remetente e o domínio verificados do Sir Barbecue (útil para dar credibilidade a um phishing reencaminhado a terceiros) e risco de reputação do domínio junto ao Resend.

**Correção recomendada.**
```ts
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function buildEmailHtml(tenantName: string, dueDateFormatted: string): string {
  const nome = escapeHtml(tenantName).slice(0, 120);
  return `<p>Olá, ${nome}!</p> ...`;
}
```
(reaproveitar o `escapeHtml` que já existe em `generate-report/index.ts:253`).

---

### A06:2025 — Insecure Design

**Status: Vulnerável** · Severidade máxima: **Alta**

---

#### `A06-01` — O bloqueio por assinatura não é aplicado no servidor

**Severidade: Alta** · Status: **Vulnerável**

**Evidência — a decisão é do servidor, mas o efeito é do cliente.**

A RPC `get_access_status` faz a avaliação corretamente e com hora do servidor — `docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql:216-286`:
```sql
if v_sub.blocked_by_owner then
  v_allowed := false; v_reason := 'blocked_by_owner';
elsif v_sub.status = 'canceled' then ...
elsif v_sub.status = 'trial' then
  if v_ends is not null and now() >= v_ends then
    v_allowed := false; v_reason := 'trial_expired';
```

Mas ela apenas **informa**. Quem age é a UI — `src/app/guards.tsx:53-61`:
```tsx
export function RequireAccess() {
  const status = useAccessStore((s) => s.status);
  if (status === 'checking') return <Splash />;
  if (status === 'blocked') return <AccessBlocked reason={reason} />;
  return <Outlet />;
}
```

E nenhuma policy de RLS consulta `subscriptions`. Todas as policies de negócio derivam exclusivamente de `user_tenant_ids()` — `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:411-500`, `MIGRATION_09_tabs.sql:72-85`. A própria RPC transacional de venda é `security invoker` e não consulta a assinatura — `MIGRATION_08_create_sale.sql:44-45` e `MIGRATION_09_tabs.sql:126-127`.

**Por que é explorável.** A empresa com trial vencido (ou suspensa pelo dono via `admin_set_tenant_access`) abre o app e vê a tela de bloqueio. Basta:

```bash
# vender normalmente, sem passar pela tela
curl -X POST "https://<ref>.supabase.co/rest/v1/rpc/create_sale" \
  -H "apikey: <anon>" -H "Authorization: Bearer <token do usuário bloqueado>" \
  -H "Content-Type: application/json" \
  -d '{"p_tenant_id":"<tid>","p_client_id":"<uuid>","p_payment_method":"pix",
       "p_consumption_mode":"on_site","p_items":[{"product_client_id":"<p>","quantity":1,"unit_price":10}]}'
```

Funciona: a RLS só verifica se o `tenant_id` é do usuário. Não exige nem editar o front — um cliente minimamente motivado (ou um concorrente que ofereça um "app alternativo" apontando para o mesmo backend) opera indefinidamente sem pagar. Note que o `token` continua sendo renovado pelo `refresh_token` sem passar por nenhuma verificação de assinatura.

Vale reconhecer o que **já está certo**: `src/core/rules/access.ts:46-49` faz o veredito não verificado ser **negado** (fail-closed) e `src/core/rules/access.ts:6-13` recusa deliberadamente cachear o veredito no `localStorage` justamente para não abrir bypass. O desenho do cliente é cuidadoso; o que falta é a contraparte no servidor.

**Impacto no negócio.** Burla direta da cobrança — receita do SaaS. E o kill switch do dono (`blocked_by_owner`), que é a última alavanca contra um cliente inadimplente ou abusivo, **não bloqueia nada de fato**.

**Correção recomendada.** Uma função de acesso, usada nas policies de escrita. Ela precisa ser barata (é avaliada por linha), então convém marcá-la `stable` e apoiá-la no índice de `subscriptions.tenant_id` (que é `unique`):

```sql
-- true = a empresa pode OPERAR agora (mesma regra da get_access_status).
create or replace function public.tenant_has_access(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.tenant_id = p_tenant_id
      and s.blocked_by_owner = false
      and (
        (s.status = 'trial'  and (s.trial_ends_at is null or now() < s.trial_ends_at))
        or (s.status = 'active' and (s.current_period_end is null
                                     or now() < s.current_period_end + interval '48 hours'))
      )
  );
$$;
grant execute on function public.tenant_has_access(uuid) to authenticated;
```

E então, nas policies de **escrita** (não nas de leitura — bloquear leitura impediria o cliente inadimplente de exportar os próprios dados, o que traz problema de LGPD e de suporte):

```sql
-- exemplo em sales; repetir em tabs, tab_items, stock_entries, products, categories, suppliers
drop policy if exists tenant_all on public.sales;
create policy sales_select on public.sales for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy sales_write on public.sales for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids())
              and public.tenant_has_access(tenant_id));
```

Adicionalmente, uma checagem explícita no início de `create_sale` dá mensagem clara em vez de erro de RLS:

```sql
if not public.tenant_has_access(p_tenant_id) then
  raise exception 'assinatura inativa: regularize para continuar vendendo';
end if;
```

> Esta mudança afeta igualmente o app Android. Recomenda-se aplicar primeiro em ambiente de teste com um tenant `trial_ends_at` no passado, validando os dois clientes.

---

#### `A06-02` — `create_sale` aceita o preço unitário ditado pelo cliente

**Severidade: Média** · Status: **Vulnerável**

**Evidência:** `docs/banco-multi-cliente/MIGRATION_09_tabs.sql:141-163`
```sql
select coalesce(sum((i->>'quantity')::numeric * (i->>'unit_price')::numeric), 0)
  into v_total
  from jsonb_array_elements(p_items) as i;
...
insert into public.sale_items (client_id, sale_client_id, product_client_id, quantity, unit_price)
select gen_random_uuid(), p_client_id,
       (i->>'product_client_id')::uuid,
       (i->>'quantity')::numeric,
       (i->>'unit_price')::numeric
from jsonb_array_elements(p_items) as i;
```

O comentário de projeto em `MIGRATION_08_create_sale.sql:26-28` diz: *"O TOTAL é calculado no servidor a partir dos itens. O cliente não dita quanto a venda valeu"*. Isso é verdade só pela metade: o **total** é somado no servidor, mas a partir de `unit_price` que veio do cliente. O servidor nunca confronta com `products.price`. No cliente, o valor sai do carrinho/comanda (`src/screens/venda/FecharVenda.tsx:111-118`), mas nada obriga a requisição a vir do app.

**Por que é explorável.** Qualquer membro (inclusive `employee`) registra a venda com `unit_price: 0.01`, entrega o produto, embolsa o valor cheio. O estoque baixa corretamente pela trigger — então a conferência "estoque consumido × faturamento" que denunciaria o A01-03 aqui também falha, porque a venda **existe**, só que com valor falso. É a variante mais silenciosa da fraude de caixa.

**Impacto no negócio.** Fraude interna sistemática, distorção do faturamento, do ticket médio e da margem calculada no relatório — o dono toma decisão de preço com base em número adulterado.

**Correção recomendada.** Deixar o snapshot de preço explícito e limitado. A comanda precisa mesmo de preço congelado (mudar o preço do produto não pode alterar comanda aberta), então a validação não pode ser igualdade estrita com `products.price`; o caminho é validar contra o preço da comanda quando houver comanda, e contra o produto quando for venda rápida:

```sql
-- dentro de create_sale, antes do insert em sale_items:
if p_tab_client_id is null then
  -- venda rápida: preço tem de bater com o cadastro (tolerância p/ arredondamento)
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    join public.products pr on pr.client_id = (i->>'product_client_id')::uuid
    where pr.tenant_id = p_tenant_id
      and abs((i->>'unit_price')::numeric - pr.price) > 0.01
  ) then
    raise exception 'preço divergente do cadastro do produto';
  end if;
else
  -- comanda: preço tem de bater com o snapshot gravado em tab_items
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    join public.tab_items ti on ti.tab_client_id = p_tab_client_id
                           and ti.product_client_id = (i->>'product_client_id')::uuid
    where abs((i->>'unit_price')::numeric - ti.unit_price) > 0.01
  ) then
    raise exception 'preço divergente da comanda';
  end if;
end if;
```

Se o negócio precisar de desconto no caixa, transformá-lo em campo explícito (`discount_amount`) autorizado por papel, em vez de um preço livre.

---

#### `A06-03` — Exclusão de conta destrói a empresa inteira sem reautenticação

**Severidade: Média** · Status: **Vulnerável**

**Evidência — no cliente:** `src/screens/conta/Conta.tsx:22-36`
```tsx
const onDelete = async () => {
  const ok = window.confirm(
    'Esta ação remove sua conta e os dados da empresa de forma permanente. É irreversível.\n\nDeseja continuar?',
  );
  if (!ok) return;
  ...
  const { error } = await deleteAccount();
```

**Evidência — no servidor:** `supabase/functions/delete-account/index.ts:65-88`
```ts
const { data } = await u.auth.getUser();
const user = data.user;
if (!user) return json({ error: 'Não autenticado.' }, 401);
const admin = adminClient();
const { data: ownedData } = await admin.from('tenants').select('id').eq('owner_user_id', user.id);
for (const t of (ownedData ?? []) as IdRow[]) {
  const { error } = await admin.from('tenants').delete().eq('id', t.id);
```

A única condição é **ter uma sessão válida**. Não há confirmação de senha, não há verificação de recência da sessão (`aal`/`amr`), não há período de carência, não há aviso aos demais membros. E o `DELETE` em `tenants` propaga em cascade para `categories`, `products`, `suppliers`, `stock_*`, `sales`, `tabs`, `reports`, `subscriptions`, `tenant_members` — ou seja, apaga também o trabalho de todos os funcionários e gerentes daquela empresa, não só o do dono.

**Por que é explorável.** Combinado com A02-01: qualquer token roubado, ou um clickjacking bem colocado sobre o botão "Excluir conta" (que não tem confirmação de digitação, só um `confirm` nativo que também pode ser vítima de UI redressing em algumas configurações), destrói a empresa inteira sem possibilidade de desfazer. Também é um risco de erro honesto: no iPhone o botão fica a dois toques de distância na tela Conta, e "Sair da conta" está logo acima dele.

**Impacto no negócio.** Perda total e irreversível dos dados de um cliente pagante — o pior incidente possível em termos de relação comercial, e potencialmente um problema contratual/LGPD (não há backup por tenant no plano gratuito).

**Correção recomendada.** Três camadas, em ordem de esforço crescente:

1. **Confirmação forte na UI** — exigir que o usuário digite o nome da empresa, não um `window.confirm`:
   ```tsx
   const digitado = window.prompt(`Digite o nome da empresa (${tenantName}) para confirmar a exclusão:`);
   if (digitado?.trim() !== tenantName) return;
   ```
2. **Reautenticação no servidor** — a função exigir a senha atual (ou um OTP recém-validado) no corpo, revalidando com `signInWithPassword` antes de apagar.
3. **Exclusão em duas fases** — marcar `tenants.deleted_at` e só apagar de fato após 7 dias, com e-mail de aviso a todos os membros. Dá tempo de reverter um engano ou um sequestro de conta.

---

#### `A06-04` — `has_pending_invite` permite enumeração anônima de e-mails

**Severidade: Baixa** · Status: **Parcialmente exposto** (risco aceito e documentado)

**Evidência:** `docs/banco-multi-cliente/MIGRATION_04_has_pending_invite.sql:18-28`
```sql
create or replace function public.has_pending_invite(p_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tenant_invites ti
    where lower(ti.email) = lower(coalesce(p_email, '')) and ti.status = 'pending' ...);
$$;
grant execute on function public.has_pending_invite(text) to anon, authenticated;
```

Chamada sem sessão em `src/data/services/auth.ts:65-72`.

**Análise.** O próprio script já documenta o trade-off (linhas 13-15) e a decisão está bem tomada: devolve apenas um booleano, sem revelar tenant, papel ou quem convidou. Um atacante anônimo pode testar e-mails em massa para descobrir quem foi convidado para alguma empresa. O valor do dado é baixo e o ganho de UX é real. **Não recomendo remover**; recomendo apenas garantir que o rate limiting do Supabase esteja ativo para chamadas anônimas de RPC (item de verificação na seção 5).

---

### A07:2025 — Authentication Failures

**Status: Parcialmente exposto** · Severidade máxima: **Baixa**

O que está correto: autenticação delegada integralmente ao Supabase Auth (GoTrue), fluxo OAuth com **PKCE** (`src/data/supabase.ts:30`), redirects fixados na origem própria (`src/data/services/auth.ts:17-20` monta a URL a partir de `window.location.origin`, sem parâmetro controlado pelo usuário — **não há open redirect**), `autoComplete` correto nos campos de senha, e logout que limpa também a trilha de navegação para não vazar rastro entre usuários no mesmo aparelho (`src/store/authStore.ts:104-115`).

O tratamento da **recuperação de senha** merece destaque positivo: o link do e-mail cria uma sessão GoTrue válida, e o app impede que ela valha como login antes de a nova senha ser definida, marcando a flag de forma **síncrona no boot**, antes de qualquer render (`src/main.tsx:23-30`), com rede de segurança no evento `PASSWORD_RECOVERY` (`src/store/authStore.ts:166-169`). É uma armadilha real de PWA, bem resolvida. Vale registrar que essa é uma proteção **de UX no cliente** — a sessão é legítima do ponto de vista do GoTrue — mas não há como ser diferente sem um backend próprio, e ela não concede nada que o dono do e-mail já não tivesse.

---

#### `A07-01` — Política de senha fraca e ausência de segundo fator

**Severidade: Baixa** · Status: **Vulnerável**

**Evidência:** `src/screens/auth/SignUp.tsx:52-53` e `src/screens/auth/ResetPassword.tsx:74-77`
```ts
if (password.length < 6) {
  setError('A senha deve ter ao menos 6 caracteres.');
```

Seis caracteres, sem exigência de composição, sem verificação contra listas de senhas vazadas, sem MFA em nenhum papel — inclusive para `owner`, que pode excluir a empresa inteira (A06-03) e gerir a equipe. Não há captcha nas telas de login/cadastro (`src/screens/auth/Login.tsx`), então a defesa contra força bruta é inteiramente o rate limiting padrão do Supabase.

**Impacto no negócio.** Comprometimento de uma conta `owner` por senha fraca dá acesso total aos dados da empresa e à exclusão irreversível.

**Correção recomendada.**
1. No painel do Supabase (Authentication → Policies), elevar o mínimo para 10 caracteres e habilitar a checagem contra HaveIBeenPwned (`Prevent use of leaked passwords`), que o GoTrue já oferece.
2. Alinhar a validação do cliente ao novo mínimo (`SignUp.tsx:52` e `ResetPassword.tsx:74`) para o usuário receber o erro antes da ida ao servidor.
3. Habilitar captcha (hCaptcha/Turnstile) em `signUp` e `signInWithPassword`.
4. Avaliar MFA (TOTP) obrigatório para o papel `owner` — o Supabase Auth suporta nativamente.

---

### A08:2025 — Software or Data Integrity Failures

**Status: Não identificado** · Severidade máxima: **Informativa**

A configuração do PWA está correta do ponto de vista de integridade e foi verificada **no artefato compilado**, não só na configuração:

- `vite.config.ts:50-69` restringe o precache ao shell (`js,css,html,png,svg,woff2`) e define **um único** `runtimeCaching`, para Google Fonts. Confirmado em `dist/sw.js` e `dist/workbox-835c8c05.js`: existe exatamente uma estratégia `CacheFirst` (as fontes) e **nenhuma referência ao domínio Supabase**. Nenhuma resposta autenticada — venda, estoque, comanda, sessão — entra no cache do service worker.
- `netlify.toml:26-42` impede o cache de `sw.js`, `registerSW.js` e `manifest.webmanifest`, o que evita o aparelho ficar preso numa versão antiga — inclusive numa versão vulnerável, depois de uma correção de segurança.
- `registerType: 'autoUpdate'` (`vite.config.ts:25`) garante que a correção chega sem depender de o operador clicar em algo no meio do atendimento.
- Não há `<script>` de CDN externo em `index.html`; o único recurso de terceiro é a folha de estilo do Google Fonts (linha 31-35).

**`A08-01` (Informativa).** A folha do Google Fonts é carregada sem `integrity`/SRI — o que é inerente ao serviço (a URL da CSS é gerada dinamicamente e não tem hash estável). O controle apropriado aqui é a CSP de A02-01, que restringe a origem; se quiser eliminar a dependência de terceiro por completo, autohospedar as fontes (`@fontsource/inter`) remove o ponto e ainda melhora o tempo de carga no 4G do trailer.

---

### A09:2025 — Security Logging and Alerting Failures

**Status: Parcialmente exposto** · Severidade máxima: **Média**

Existe uma infraestrutura de observabilidade acima da média para um projeto deste porte: log estruturado de erros com código de referência ditável por telefone (`src/data/services/errorLog.ts`), redação de credenciais antes da gravação (`src/core/rules/errors.ts:22-41`), trilha de navegação anexada ao erro, endpoint público de saúde com round-trip real ao Postgres (`supabase/functions/health/index.ts`), webhook de histórico de quedas (`health-webhook`) e monitor externo. Nada disso é *segurança*, porém — é disponibilidade e diagnóstico.

---

#### `A09-01` — Não há trilha de auditoria de eventos sensíveis

**Severidade: Média** · Status: **Vulnerável**

**Evidência (ausência).** Busca no schema e nas migrações por qualquer tabela ou trigger de auditoria: só existe `error_logs` (`MIGRATION_05_error_logs.sql`), que registra **erros técnicos**, e `health_events` (`MIGRATION_07_health_events.sql`), que registra **quedas de infraestrutura**. Nenhuma das operações abaixo deixa rastro consultável:

| Evento | Onde acontece | Rastro hoje |
|---|---|---|
| Convite de membro | `invite-member/index.ts:137-143` | só a linha em `tenant_invites` (some ao ser aceita/reescrita: `linhas 131-136` fazem `DELETE` do convite pendente anterior) |
| Remoção de membro | `src/data/services/tenant.ts:70-81` (`DELETE` direto) | nenhum |
| Exclusão de conta/empresa | `delete-account/index.ts:78-85` | nenhum |
| Alteração de preço de venda | `products` UPDATE | nenhum (só o custo de compra tem histórico, via `trg_log_price_history`) |
| Exclusão de venda | `sales` DELETE (ver A01-03) | nenhum |
| Bloqueio/liberação de tenant | `admin_set_tenant_access` | nenhum |

**Por que importa.** Todos os achados de fraude interna deste relatório (A01-03, A06-02) têm em comum que, se acontecerem, **não há como descobrir quem fez**. As colunas `user_id` das tabelas de negócio guardam quem *criou* a linha, mas um `DELETE` leva a linha e o `user_id` junto. Sem trilha, o dono não consegue nem responder "quem apagou a venda de sexta?", nem o operador da plataforma consegue investigar um cliente que alega vazamento.

**Impacto no negócio.** Impossibilidade de investigar incidente, atribuir responsabilidade ou atender a um pedido de prestação de contas — e, num vazamento envolvendo dados pessoais (nome de fornecedor, telefone, e-mail de membro), dificuldade de cumprir o dever de registro previsto na LGPD.

**Correção recomendada.** Uma tabela de auditoria append-only, escrita por trigger `SECURITY DEFINER` (o cliente nunca escreve nem apaga):

```sql
create table if not exists public.audit_log (
  id         bigserial primary key,
  tenant_id  uuid,
  actor_id   uuid default auth.uid(),
  action     text not null,           -- 'sale.delete', 'member.remove', 'tenant.delete', ...
  target     text,                    -- id do objeto afetado
  before     jsonb,
  at         timestamptz not null default now()
);
alter table public.audit_log enable row level security;
-- só owner da empresa e super-admin leem; ninguém escreve pelo cliente
create policy audit_read on public.audit_log for select to authenticated
  using (public.is_platform_admin()
         or (tenant_id is not null and public.is_tenant_owner(tenant_id)));

create or replace function public.audit_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (tenant_id, action, target, before)
  values (old.tenant_id, tg_table_name || '.delete', old.client_id::text, to_jsonb(old));
  return old;
end; $$;

create trigger trg_audit_sales_delete before delete on public.sales
  for each row execute function public.audit_delete();
```

Cobrir no mínimo: `sales` (DELETE e UPDATE de `total_amount`), `tenant_members` (DELETE e UPDATE de `role`), `tenants` (DELETE) e `products` (UPDATE de `price`). Complementarmente, registrar em `audit_log` também as chamadas de `invite-member` e `delete-account` a partir das próprias Edge Functions, e configurar um alerta (o mesmo canal do `health-webhook` serve) para exclusão de empresa.

---

### A10:2025 — Mishandling of Exceptional Conditions

**Status: Parcialmente exposto** · Severidade máxima: **Baixa**

O tratamento de erro é, em geral, bem pensado. Destaques positivos:

- **Fail-closed no gate de assinatura**: `src/core/rules/access.ts:46-49` — servidor sem resposta resulta em `allowed: false`, nunca em "deixa passar". `src/data/services/access.ts:44-49` registra o erro para que um bloqueio indevido não passe despercebido.
- **Fail-closed nas funções com segredo**: `health-webhook/index.ts:63-67` e `send-subscription-reminder/index.ts:54-58` recusam tudo se o token não estiver configurado, e devolvem **404** (não 401) para não confirmar a existência do endpoint a quem varre.
- **O endpoint público não vaza schema**: `health/index.ts:73-85` devolve apenas códigos genéricos (`db_error`, `db_unexpected`, `db_unreachable`) e manda a mensagem crua do Postgres só para o log da função. O comentário nas linhas 16-18 mostra que isso foi decisão consciente.
- **Redação de credenciais antes de qualquer gravação**: `src/core/rules/errors.ts:22-41` mascara `Bearer`, JWTs soltos e valores de chaves sensíveis, **na ordem correta** (o comentário explica por que Bearer/JWT vêm antes das chaves nomeadas — detalhe sutil e certo).
- **O módulo de log nunca lança** (`src/data/services/errorLog.ts:69-126`), evitando que falhar ao registrar um erro vire um segundo erro.

---

#### `A10-01` — Edge Functions devolvem a mensagem crua da exceção ao cliente

**Severidade: Baixa** · Status: **Vulnerável**

**Evidência:** o mesmo `catch` se repete em quatro funções —
`invite-member/index.ts:163-165`, `delete-account/index.ts:89-91`, `generate-report/index.ts:244-246`, `send-push/index.ts:104-106`:

```ts
} catch (e) {
  return json({ error: String((e as Error)?.message ?? e) }, 400);
}
```

Essa string chega ao cliente e é exibida **diretamente ao usuário**. `src/data/services/functions.ts:26-33` extrai o campo `error` do corpo e o repassa, e a tela mostra sem filtro — `src/screens/empresa/Empresa.tsx:130-133`:
```tsx
const { error, invited } = await inviteMember(email, inviteRole);
if (error) { showToast(error, 'error'); return; }
```

**Por que é explorável.** Os erros que passam por ali vêm do PostgREST e do GoTrue: `duplicate key value violates unique constraint "uq_tenant_invites_pending"`, `new row violates row-level security policy for table "reports"`, `null value in column "..." violates not-null constraint`. São nomes de tabela, de coluna, de constraint e de policy — o mapa interno do banco, entregue a qualquer usuário autenticado (inclusive um `employee`), em texto, dentro de um toast. Não abre acesso sozinho, mas é reconhecimento gratuito para quem for montar os ataques de A01/A06.

Note a assimetria: o caminho de erro do **cliente** é exemplar — `src/core/rules/errors.ts:149-183` traduz tudo para frases sem jargão e o detalhe técnico só vai para o log. Esse cuidado simplesmente não existe do lado da Edge Function.

**Impacto no negócio.** Vazamento de estrutura interna e experiência ruim (o dono lê uma mensagem em inglês sobre `constraint` quando o que houve foi "esse e-mail já foi convidado").

**Correção recomendada.** Padronizar o `catch` das funções: log completo no servidor, mensagem genérica com código de referência para o cliente.

```ts
} catch (e) {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`[invite-member ${ref}]`, e);   // fica no log da função
  return json({ error: 'Não foi possível concluir a operação.', ref }, 400);
}
```

Manter mensagens específicas apenas para os casos de negócio já tratados explicitamente (`'Informe o e-mail.'`, `'Apenas o dono (owner) pode convidar membros.'`, `'Intervalo máximo do relatório é de 1 ano.'`), que são seguras e úteis.

---

## 4. Plano de correção priorizado

Ordenado por severidade × esforço. Esforço: **P** (até ~2h) · **M** (meio dia a 1 dia) · **G** (vários dias, exige teste com o app Android).

### Onda 1 — corrigir agora

| # | ID | Ação | Arquivos / objetos | Esforço | Onde muda |
|---|---|---|---|---|---|
| 1 | A02-01 | Adicionar bloco `[[headers]] for = "/*"` com CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy e Permissions-Policy | `netlify.toml` | **P** | Só frontend (deploy) |
| 2 | A01-02 | Checar papel `owner\|manager` no início da função e mover o `upload` para depois do `INSERT` | `supabase/functions/generate-report/index.ts` | **P** | Edge Function (redeploy) |
| 3 | A01-04 | Incluir `tenant_id` no `with check` das policies de INSERT/UPDATE de `error_logs` | `error_logs` (RLS) | **P** | Supabase (SQL) |
| 4 | A06-01 | Criar `tenant_has_access(uuid)` e exigi-la nas policies de **escrita** + guarda explícita em `create_sale` | `subscriptions`, policies de `sales`/`tabs`/`tab_items`/`stock_entries`/`products`/`categories`/`suppliers`, `create_sale` | **G** | Supabase (SQL) — **validar com o Android** |
| 5 | A06-02 | Validar `unit_price` contra `products.price` (venda rápida) e contra `tab_items.unit_price` (comanda) dentro de `create_sale` | `create_sale` | **M** | Supabase (SQL) |

### Onda 2 — curto prazo

| # | ID | Ação | Arquivos / objetos | Esforço | Onde muda |
|---|---|---|---|---|---|
| 6 | A01-01 | Restringir a `owner\|manager` a leitura de `suppliers`, `product_suppliers` e `product_supplier_price_history` | RLS dessas 3 tabelas | **M** | Supabase (SQL) |
| 7 | A01-01b | Avaliar restrição da leitura histórica de `sales` para `employee` | RLS de `sales` | **M** | Supabase — **validar com o Android** |
| 8 | A06-03 | Confirmação por digitação do nome da empresa + reautenticação por senha na função | `src/screens/conta/Conta.tsx`, `supabase/functions/delete-account/index.ts` | **M** | Frontend + Edge Function |
| 9 | A01-03 | Separar policies de `sales`/`sale_items`: SELECT+INSERT para membros, UPDATE/DELETE só `owner` | RLS de `sales`, `sale_items`, `tabs` | **M** | Supabase (SQL) |
| 10 | A10-01 | Padronizar `catch` das 4 Edge Functions: log no servidor + mensagem genérica com `ref` | `invite-member`, `delete-account`, `generate-report`, `send-push` | **P** | Edge Functions (redeploy) |
| 11 | A07-01 | Elevar mínimo de senha para 10, habilitar checagem de senha vazada e captcha; alinhar validação no cliente | Painel Supabase + `SignUp.tsx:52`, `ResetPassword.tsx:74` | **P** | Supabase (painel) + frontend |

### Onda 3 — endurecimento

| # | ID | Ação | Arquivos / objetos | Esforço | Onde muda |
|---|---|---|---|---|---|
| 12 | A09-01 | Criar `audit_log` + triggers de auditoria em `sales`, `tenant_members`, `tenants`, `products.price`; registrar convite/exclusão nas funções | Novo objeto + triggers + Edge Functions | **G** | Supabase + Edge Functions |
| 13 | A03-01 | Fixar versão exata do `@supabase/supabase-js` nos imports das 6 funções; avaliar `deno.lock` ou `npm:` | todas as `supabase/functions/*/index.ts` | **P** | Edge Functions (redeploy) |
| 14 | A05-01 | Escapar `tenantName` no HTML do e-mail | `send-subscription-reminder/index.ts:41-51` | **P** | Edge Function (redeploy) |
| 15 | A02-02 | Alinhar `send-push` ao padrão `corsHeadersFor(req)` + `Vary: Origin` | `send-push/index.ts:12-24` | **P** | Edge Function (redeploy) |
| 16 | A08-01 | Autohospedar as fontes (`@fontsource/inter`) e remover a dependência do Google Fonts | `index.html`, `src/index.css`, `package.json` | **P** | Frontend |
| 17 | A02-03 | Garantir que `VITE_ACCESS_BYPASS` não está definido na Netlify; fazer o build falhar se `true` em produção | Painel Netlify, `vite.config.ts` | **P** | Deploy |
| 18 | A07-01b | Avaliar MFA (TOTP) obrigatório para o papel `owner` | Painel Supabase + fluxo de login | **G** | Supabase + frontend |

---

## 5. Itens não verificáveis pelo código

Confira cada item no painel — o repositório contém os scripts, não o estado real do ambiente.

> **Verificação de 02/09/2026:** os três primeiros itens do bloco "Supabase — banco" foram conferidos contra o estado real do banco. Resultado completo em [CONFERENCIA_POLICIES_PRODUCAO.md](./CONFERENCIA_POLICIES_PRODUCAO.md).

### Supabase — banco

- [X] **RLS está de fato habilitada** em todas as tabelas de negócio? Rode: `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;` — todas devem ter `relrowsecurity = true`.
  **✔ 02/09/2026 — 26 de 26 tabelas com `relrowsecurity = true`.** `relforcerowsecurity = false` em todas é o correto: o PostgREST atende pelo papel `authenticator` (nunca dono da tabela), e ligar FORCE quebraria as funções `SECURITY DEFINER` que dependem de rodar como dono para não recursar na própria RLS.
- [X] **As policies em produção batem com os scripts?** Rode `select tablename, policyname, cmd, qual from pg_policies where schemaname = 'public' order by 1, 2;` e compare com `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` + `MIGRATION_09_tabs.sql` + `SUPABASE_SCHEMA_LICENSING.sql`. Alterações manuais no SQL Editor não aparecem no repositório.
  **✔ 02/09/2026 — batem 100%**, conferidas também em `with_check`, `permissive` e `roles` (não só `qual`). 31 policies dos três scripts + 8 das MIGRATION_02 a 07 = as 39 de produção; nenhuma sobra dos dois lados. Único ponto fora do padrão: `push_tokens.tenant_all` com `roles = {public}` — encaminhado por **remoção** da tabela (`MIGRATION_16_drop_push_infra.sql`), não por correção da policy.
- [X] **`MIGRATION_02_invites_table.sql` foi aplicada?** É a correção crítica de escalada de privilégio da auditoria anterior. Confirme que `handle_new_user_invite` lê a **tabela** `tenant_invites` e não `raw_user_meta_data->>'invited_to_tenant'` (a versão vulnerável está em `MIGRATION_01_invite_trigger.sql:51-53`): `select prosrc from pg_proc where proname = 'handle_new_user_invite';`.
  **✔ 02/09/2026 — aplicada por inteiro.** `trg_handle_new_user` e `trg_handle_new_user_invite` presentes em `auth.users` e habilitados (`tgenabled = 'O'`), e as duas funções referenciam `tenant_invites`. ⚠️ **Risco de regressão:** `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:615` redefine `handle_new_user` na versão antiga — reexecutar o schema base desfaz esta correção em silêncio. O schema base ganhou um cabeçalho de "NÃO REEXECUTE EM PRODUÇÃO" em 02/09/2026.
- [X] **`MIGRATION_03_stock_triggers_tenant_scope.sql` foi aplicada?** Confirme que `deduct_stock_on_sale` contém a validação `produto de outra empresa no item de venda (cross-tenant)`. Sem ela, volta o acesso cross-tenant ao estoque.
  **✔ 02/09/2026 — aplicada.** `prosrc` de `deduct_stock_on_sale` contém a guarda cross-tenant. ⚠️ **Mesmo risco de regressão do item anterior:** `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:324-331` redefine essa função **sem** a guarda — reexecutar o schema base reabre o acesso cross-tenant ao estoque em silêncio. O schema base ganhou um cabeçalho de "NÃO REEXECUTE EM PRODUÇÃO" em 02/09/2026.
- [X] **`MIGRATION_04_tenant_owner_email.sql` foi aplicada?** O arquivo está **não rastreado** no Git (`??` em `git status`) — confirme se já foi executado no banco e, em qualquer caso, versione-o.
  **✔ 02/09/2026 — executada em produção** (confirmado pelo dono; para evidência direta: `select prosrc like '%u.email%' as tem_email from pg_proc where proname = 'admin_tenant_detail';`). Ela só acrescenta o campo `email` ao retorno de `admin_tenant_detail`, vindo de `auth.users` via `tenants.owner_user_id`. **Sem risco de regressão:** ao contrário do schema base multi-tenant, o `SUPABASE_SCHEMA_LICENSING.sql` já carrega a mesma versão da função — reexecutá-lo não desfaz esta migração. ⏳ **Continua pendente versionar o arquivo:** ele segue `??` no `git status` em `docs/assinatura-app/`.
- [X] **`platform_admins` contém só quem deve?** `select * from public.platform_admins;` — cada linha ali lê e escreve dados financeiros de **todos** os clientes.
  **✔ 02/09/2026 — uma única linha** (`user_id` `2574e792…`, criada em 22/07/2026), que é o esperado: só o dono da aplicação. Para amarrar a identidade ao e-mail: `select u.email, pa.created_at from public.platform_admins pa join auth.users u on u.id = pa.user_id;`.
- [X] **Realtime das comandas respeita a RLS?** `src/data/queries/tabs.ts:44-48` assina `postgres_changes` em `tabs` e `tab_items` **sem filtro de tenant**, contando com a RLS para filtrar. A policy de `tab_items` depende de um `EXISTS` na tabela pai, e o filtro de Realtime tem limitações conhecidas com policies que referenciam outras tabelas. **Teste prático:** abra o app com um usuário da empresa A e, em outra sessão, crie/altere uma comanda na empresa B — confirme que a sessão A não recebe evento algum. Se receber, adicione `filter: 'tenant_id=eq.<id>'` no canal e considere desnormalizar `tenant_id` em `tab_items`.

  **✔ 03/09/2026 — testado empiricamente, isolamento confirmado. Nenhuma mudança necessária.**

  Método: DevTools → Network → filtro **Socket** → recarregar a página (o socket precisa ser aberto com o DevTools já gravando) → clicar na conexão `websocket?apikey=…` → aba **Messages** → filtro `"record"` (esconde heartbeats e as confirmações de inscrição, que também contêm a string `postgres_changes` mas são só a config ecoada). Duas empresas reais, ambas no PWA — "Espetinho Dev" no desktop, "Espetinho Pani" no celular.

  | # | Ação | Tabela | Resultado |
  |---|---|---|---|
  | 1 | **Controle positivo** — item alterado no Dev pelo celular, observando o Dev no desktop | `tab_items` | ✅ frame recebido: `{"table":"tab_items","type":"UPDATE","record":{"name":"Espetinho Frango","quantity":3.000,…}}` |
  | 2 | Comanda criada no **Pani**, observando o Dev | `tabs` | ✅ silêncio |
  | 3 | Itens lançados numa comanda do **Pani**, observando o Dev | `tab_items` | ✅ silêncio |

  O passo 1 é o que dá valor aos outros dois: sem provar que o canal **entrega** quando deve, silêncio não distingue "a RLS filtrou" de "o Realtime não está entregando nada". Os passos 1 e 3 são **a mesma operação**, mudando só a empresa — por isso a comparação conclui.

  O passo 3 é o que a auditoria apontava como risco: `tabs` tem `tenant_id` na própria linha (fácil de filtrar), enquanto a policy de `tab_items` depende de um `EXISTS` na comanda-pai. **O Realtime aplica a RLS corretamente também nesse caso** — não foi preciso adicionar `filter` no canal nem desnormalizar `tenant_id` em `tab_items`.

  Vale notar o que o frame do passo 1 mostra: o payload carrega os dados da linha (nome do produto, quantidade). Um vazamento aqui exporia conteúdo real de outra empresa, não apenas metadado — e ele apareceria mesmo sem a tela renderizar nada, já que os dois clientes ignoram o payload e apenas refazem a consulta via PostgREST (`sir-barbecue-web/src/data/queries/tabs.ts:40-47` e, no app nativo, `src/data/sync/tabsLive.ts:40-47`). Por isso o teste tem de ser feito nos frames do WebSocket, não na tela.
- [X] **Custom Access Token Hook (`add_tenant_claims`) está habilitado?** `invite-member/index.ts:80-84` e `generate-report/index.ts:75-78` preferem o claim `app_metadata.tenant_ids` quando o corpo não traz `tenant_id`. Se o hook estiver ligado e o claim estiver desatualizado (usuário adicionado a uma segunda empresa sem refresh do token), a função pode escolher o tenant errado — não é vazamento (a RLS confirma), mas gera comportamento confuso.

  **✔ 03/09/2026 — investigado e resolvido. O hook estava LIGADO, porém INERTE.**

  Um JWT real de sessão trazia `"app_metadata": {…, "tenant_ids": []}` — array **vazio** para um usuário que é dono de empresa, e num token emitido minutos antes (não era claim velho).

  **Causa:** `add_tenant_claims` estava declarada sem `security definer`. O hook executa como `supabase_auth_admin`; o `grant select on tenant_members` do schema resolve a permissão de tabela, mas **não a RLS** — as policies de `tenant_members` são `to authenticated`, papel que esse role não tem (`rolbypassrls = false` e `rolsuper = false`, confirmados em `pg_roles`). Nenhuma policy se aplicava, a RLS negava tudo e o `jsonb_agg` agregava zero linhas. Falha totalmente silenciosa: o claim existia, só vinha vazio.

  **Consequência:** o risco descrito neste item nunca chegou a existir. Com `[]`, o teste `typeof ids[0] === 'string'` reprova nas duas funções e elas caem no `select … from tenant_members limit 1`, que é a consulta ao vivo com RLS — o comportamento correto, por acidente. Verificado também que **nenhum usuário pertence a duas empresas** hoje (`select user_id, count(*) from tenant_members group by user_id having count(*) > 1` → zero linhas), então a escolha arbitrária não tinha como errar.

  **Ações tomadas:**
  1. **Hook desligado** no painel (03/09/2026), com login, Comandas e geração de relatório testados depois — funcionamento normal. Nada lia o claim de forma útil: as únicas referências no código são o ramo morto de `generate-report/index.ts:78-81` e `invite-member/index.ts:83-87`, e nenhuma policy usa `auth.jwt()`. Desligar também tira do caminho crítico da autenticação uma função que, se lançasse exceção, impediria a emissão de token para todos.
  2. **Clientes blindados:** `generateReport` e `inviteMember` passaram a enviar `tenant_id` no corpo (app e PWA), o que ativa o ramo que **valida** a associação contra `user_tenant_ids()` e usa exatamente a empresa da tela. Elimina de vez o fallback arbitrário — note que nem o claim (`[0]`) nem a consulta (`limit(1)`) tinham ordenação.
  3. **Schema corrigido e documentado:** `add_tenant_claims` ganhou `security definer set search_path = public`, e o bloco "VARIANTE RÁPIDA" — que sugeria trocar as policies por leitura do claim — virou um aviso. Adotá-lo com o hook desligado faria **toda consulta de toda tabela voltar vazia**, sem erro visível.
- [X] **Rate limiting de RPC anônima** está ativo? Relevante para `has_pending_invite` (A06-04) e para as telas de login/cadastro.
  **✔ 03/09/2026 — verificado, com uma correção de premissa: esse ajuste NÃO EXISTE.** O Supabase limita as rotas do **Auth** (Dashboard → Authentication → Rate Limits), não as do PostgREST. Não há limite por rota da Data API configurável; o que protege ali é a defesa de borda contra DDoS, que não impede enumeração lenta.
  - **Auth (existe e está ativo):** sign-ups/sign-ins **30 por 5 min por IP** (360/h), token verifications 30/5min, token refreshes 150/5min. Cobre a força bruta nas telas de login e cadastro.
  - **RPC anônima (`has_pending_invite`):** sem limitador. Decisão: **aceitar**, como o próprio A06-04 concluiu — o dado exposto é um booleano ("este e-mail tem convite pendente"), sem revelar empresa, papel ou quem convidou. Se um dia incomodar, a correção não é rate limit e sim tirar a pergunta do anônimo: o convite já chega por e-mail, então o link pode carregar um token que a tela de cadastro lê, eliminando a enumeração em vez de apenas desacelerá-la.
  - ⚠️ **Achado operacional grave encontrado na mesma tela:** `Rate limit for sending emails` = **2 e-mails/hora** (padrão do SMTP embutido). Isso governa o convite de membro (`inviteUserByEmail`) e a recuperação de senha — cadastrar três funcionários na mesma hora **falha no terceiro**, em silêncio para quem convida. Corrigir apontando o SMTP do Auth para a Resend (já usada pelo lembrete de assinatura) em Authentication → SMTP Settings.

- [X] **O que mais um anônimo consegue executar?** (item acrescentado em 03/09/2026, ao investigar o anterior)
  `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'EXECUTE');` devolveu **37 funções** — praticamente tudo em `public` era chamável com a anon key, que é pública.
  **Nada explorável foi encontrado:** as 16 `admin_*` abrem com `if not is_platform_admin() then raise exception` (verificadas uma a uma, incluindo as destrutivas como `admin_run_error_logs_cleanup`, cuja checagem vem antes do `delete`); os helpers (`user_tenant_ids`, `is_tenant_owner`…) devolvem vazio sem `auth.uid()`; `bind_device` e `get_access_status` falham fechado; `create_sale` é `security invoker` e esbarra na RLS; e 11 são funções de trigger, que o Postgres não deixa chamar diretamente.
  **Mas nada disso era por desenho.** Era o default do Postgres somado aos default privileges do Supabase, com a segurança dependendo só da checagem interna de cada função.
  **Descoberta relevante:** `revoke ... from public` **não basta** no Supabase — a plataforma concede EXECUTE a `anon` por default privileges, e isso é grant explícito. Prova em produção: mesmo depois do `revoke all on function create_sale from public` da MIGRATION_09, o ACL era `{postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}` — o PUBLIC saiu, o `anon` ficou.
  **Correção escrita:** `MIGRATION_17_revoke_anon_execute.sql` revoga EXECUTE de `public` **e** `anon` em tudo, exceto `has_pending_invite` e `saude_db` (anônimas por desenho), re-concedendo a `authenticated` apenas onde ele já tinha — sem tocar em `service_role`. Inclui `alter default privileges` para que a próxima função criada não nasça anônima.
  **`rls_auto_enable` / event trigger `ensure_rls`:** apareceu na lista e **não está versionada** em nenhum script do repositório. É `returns event_trigger`, SECURITY DEFINER, ligada a `ddl_command_end` — habilita RLS automaticamente em toda tabela nova de `public`. Não é chamável (era ruído na lista) e **não deve ser removida**: é ela que garante o 26/26 de RLS habilitada. Documentada na MIGRATION_17. Efeito a conhecer: liga a RLS mas não cria policy, então tabela nova nasce fechada até alguém escrever uma.

### Supabase — Edge Functions

> **Nota de 03/09/2026:** este bloco é quase todo sobre **valores de secrets** e **estado de deploy** — nada disso existe no banco nem no repositório, então a conferência por SQL/código não alcança. O que deu para fechar por código está marcado abaixo; o resto exige o painel ou a CLI.

- [X] **O padrão de CORS está correto no código de todas as funções?** (sub-item acrescentado em 03/09/2026)
  **✔ Varredura nas 6 funções restantes** (a `send-push` foi removida — ver seção 6 de [CORRECOES_APLICADAS.md](./CORRECOES_APLICADAS.md)):
  - As 4 chamadas pelo navegador — `generate-report`, `invite-member`, `delete-account`, `health` — usam o mesmo padrão: `ALLOWED_ORIGIN` lido como **lista** (`split(',')`), eco **apenas da origem que bateu** (`ALLOWED_ORIGINS.includes(origin)`) e `Vary: Origin`. **Nenhuma emite curinga** em `Access-Control-Allow-Origin`.
  - As 2 não-navegador — `health-webhook` (chamada pelo HetrixTools) e `send-subscription-reminder` (chamada pelo Postgres via `pg_net`) — **não emitem cabeçalho CORS algum**, que é o correto: não há navegador na frente. Ambas são **fail-closed por token**: se `SAUDE_WEBHOOK_TOKEN` / `SUBSCRIPTION_REMINDER_TOKEN` não estiver configurada, recusam tudo em vez de aceitar tudo.
  - `supabase-js` fixado em `2.112.4` nas 5 que usam o SDK (A03-01 atendido no código). `send-subscription-reminder` não usa o SDK — nada a fixar.

  Isto valida o **código**. O **valor** do `ALLOWED_ORIGIN` continua sendo o item abaixo.

- [X] **`ALLOWED_ORIGIN`** contém exatamente as origens legítimas (produção do PWA, painel admin, `http://localhost:5173`) e **nenhum curinga**. Lembre que `supabase secrets set` **substitui** o valor inteiro.
  **✔ 04/09/2026 — conferido. Valor atual:**
  ```
  https://sir-barbecue-admin.netlify.app,http://localhost:5173,http://192.168.0.188:5173
  ```
  (secret atualizado em 30/08/2026, data coerente com o commit `63788f8`, que passou o CORS a aceitar múltiplas origens.)

  - ✅ **Nenhum curinga.** Três entradas explícitas, sem espaços ou barra final — o `.trim().replace(/\/+$/, '')` das funções normaliza mesmo assim.
  - ✅ **Painel admin em produção** presente, o que explica o painel funcionar.
  - ⚠️ **Duas origens de desenvolvimento em secret de produção:** `http://localhost:5173` e `http://192.168.0.188:5173` (o IP da máquina de dev na LAN, usado para abrir o PWA no celular).

    **Risco real: baixo.** As funções exigem `Authorization: Bearer <jwt>`, header que o navegador **não** envia sozinho — não há cookie de sessão. Uma página hospedada numa dessas origens não teria como usar a sessão de outra pessoa; precisaria do token dela. CORS aqui não é a barreira de autorização, é higiene.

    Ainda assim vale limpar quando puder, por dois motivos práticos: `192.168.0.188` é endereço de DHCP, que muda de dono sem avisar; e origens de dev num secret de produção envelhecem mal — daqui a um ano ninguém lembra por que estão ali.

  - ⏳ **Falta a origem de produção do PWA** — porque ele ainda não foi publicado. Quando for, lembrar que `supabase secrets set` **substitui o valor inteiro**: é preciso reescrever a lista completa, não acrescentar. E as funções leem a variável no boot, então exige **redeploy** delas depois.
- [X] **`health` é a única função com `--no-verify-jwt`** entre as que rodam autenticadas? (`health-webhook` e `send-subscription-reminder` também são públicas por desenho, mas ambas são fail-closed por token.)

  **✔ 04/09/2026 — conferido função a função** em Dashboard → Edge Functions → *Settings* → **Verify JWT with legacy secret**:

  | Função | Verify JWT | Esperado | |
  |---|---|---|---|
  | `generate-report` | ON | ON — exige usuário logado | ✅ |
  | `invite-member` | ON | ON | ✅ |
  | `delete-account` | ON | ON | ✅ |
  | `health` | OFF | OFF — monitor externo, sem credencial do Supabase | ✅ |
  | `health-webhook` | OFF | OFF — HetrixTools; fail-closed por `SAUDE_WEBHOOK_TOKEN` na URL | ✅ |
  | `send-push` | ON | *(função removida)* | ⚠️ ver abaixo |

  **Nenhuma divergência entre o estado publicado e o desenho.** As três que atendem usuário logado exigem JWT; as duas públicas por desenho não exigem, e ambas protegem-se por token próprio.

  ⚠️ **`send-push` ainda estava publicada** na data da conferência (última atualização "a month ago"), com Verify JWT ligado. Ela foi removida do repositório em 03/09/2026 e o endpoint seria derrubado por `supabase functions delete send-push` — ver seção 6 de [CORRECOES_APLICADAS.md](./CORRECOES_APLICADAS.md). Enquanto o delete não é feito, o endpoint responde, mas sem efeito: sua única fonte de tokens era `push_tokens`.

  ⏳ **`send-subscription-reminder` não pôde ser conferida — ela não está publicada.** A funcionalidade de aviso de vencimento por e-mail ainda não foi concluída (ver os dois itens de secrets abaixo). Quando for ao ar, precisa sair com **Verify JWT desligado**: quem a chama é o Postgres via `pg_net`, sem JWT, autenticando por token na querystring. Este ponto faz parte do checklist de conclusão daquele recurso, não desta auditoria.

  > **Nota de plataforma:** o toggle chama-se "Verify JWT **with legacy secret**" e o próprio painel sugere "OFF with JWT and custom auth logic in your function code". As seis funções já fazem autorização própria (`getUser()` + checagens internas), o que é relevante para a futura migração das chaves legadas do Supabase.
- [X] **`SAUDE_WEBHOOK_TOKEN` e `SUBSCRIPTION_REMINDER_TOKEN`** estão configurados e são longos e aleatórios? Sem eles as funções recusam tudo (bom), mas o histórico de saúde e os lembretes param de funcionar.
  **⚠️ 04/09/2026 — verificado, e METADE ESTÁ FALTANDO.** Os *Custom secrets* do projeto têm **apenas dois**: `ALLOWED_ORIGIN` (atualizado 30/08/2026) e `SAUDE_WEBHOOK_TOKEN` (16/08/2026).

  **Não existem: `SUBSCRIPTION_REMINDER_TOKEN`, `RESEND_API_KEY` e `EMAIL_FROM`** — as três variáveis que `send-subscription-reminder` lê (`index.ts:16-18`).

  **Consequência: o lembrete de vencimento ainda não está no ar — e isso é esperado.** Confirmado pelo dono em 04/09/2026: **a funcionalidade de aviso de vencimento por e-mail ainda não foi implementada**. O código da função e a RPC existem no repositório, mas o deploy e a configuração nunca foram feitos porque o recurso não foi concluído. Não é regressão nem configuração perdida: é pendência de implementação.

  O comportamento observado bate com isso e é o correto: sem `SUBSCRIPTION_REMINDER_TOKEN` a função responde `503 not configured` a qualquer chamada (`index.ts:71-75`), e `send_subscription_due_reminders()` aborta se o segredo do Vault não estiver lá. Fail-closed dos dois lados.

  ⚠️ **O que merece atenção quando o recurso for concluído:** os dois lados falham em **silêncio** — a RPC só emite `raise notice`, e a função devolve 503 para um `net.http_post` cujo retorno ninguém lê. Se o `pg_cron` for agendado com a configuração incompleta, o lembrete simplesmente não sai e nada acusa. Vale prever um sinal de que o envio ocorreu (contagem, log, ou uso do `due_reminder_sent_for` como evidência).

  **Para ativar** (ordem importa — o mesmo valor nos dois lugares):
  ```bash
  # 1) gere UM segredo e use nos dois passos
  supabase secrets set SUBSCRIPTION_REMINDER_TOKEN="<segredo longo e aleatório>"
  supabase secrets set RESEND_API_KEY="re_xxx..."
  supabase secrets set EMAIL_FROM="Sir Barbecue <assinatura@seu-dominio>"
  ```
  ```sql
  -- 2) o MESMO valor no Vault, que é de onde o Postgres o lê
  select vault.create_secret('<o mesmo segredo>', 'subscription_reminder_token');
  ```
  Depois, `supabase functions deploy send-subscription-reminder --no-verify-jwt` e o agendamento no `pg_cron`. `SAUDE_WEBHOOK_TOKEN` está OK — o histórico de saúde funciona.
- [X] **`SUPABASE_SERVICE_ROLE_KEY`** existe apenas como secret de Edge Function — nunca em variável de ambiente da Netlify, nunca com prefixo `VITE_`.
  **✔ 04/09/2026 — confirmado nos dois lados.**
  - *Repositórios:* `service_role` / `SERVICE_ROLE` não aparece em nenhum código de cliente dos três projetos (`sir-barbecue/src`, `sir-barbecue/app`, `sir-barbecue-web/src`, `sir-barbecue-admin/src`) nem no `netlify.toml`; nenhum `.env` versionado; o `.env.example` do PWA pede só `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
  - *Netlify (`sir-barbecue-admin`, o site publicado):* apenas 4 variáveis, todas `VITE_*` — `VITE_HEALTH_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_USE_MOCK`. Nenhuma chave de serviço.
  - ⏳ **Repetir quando o PWA `sir-barbecue-web` for publicado** — hoje ele não tem site na Netlify (deploy HTTPS ainda pendente), então a conferência cobre só o painel admin.
  - 📌 Observação nova: `VITE_USE_MOCK` está definida com o mesmo valor em todos os contextos de deploy. Precisa ser `false` em produção, pela mesma razão de `VITE_ACCESS_BYPASS` (A02-03) — ver o bloco Netlify abaixo.
- [X] O secret do Vault `subscription_reminder_token` bate com `SUBSCRIPTION_REMINDER_TOKEN` (`SUPABASE_SCHEMA_LICENSING.sql:403-404` e `423`).
  **Prejudicado — 04/09/2026: não há o que comparar, e é o esperado.** A funcionalidade de aviso de vencimento por e-mail **ainda não foi implementada** (confirmado pelo dono); `SUBSCRIPTION_REMINDER_TOKEN` não existe nos secrets. Este item é, na prática, parte do checklist de conclusão desse recurso. A verificação passa a valer quando o lembrete for configurado — e a forma de garantir a igualdade é **gerar um único valor** e usá-lo nos dois lugares (`supabase secrets set` + `vault.create_secret`), já que os valores não são comparáveis por consulta: o do Vault é legível, o da Edge Function não.
  **Teste funcional depois de configurar:** `select public.admin_run_subscription_due_reminders_now();` com alguma assinatura dentro da janela de 5 dias do vencimento — sem isso o loop não seleciona ninguém e o "sucesso" não prova nada.

### Supabase — Auth e Storage

- [X] **Redirect URLs** contêm apenas os domínios próprios (`https://<dominio>/**`, `http://localhost:5173/**`). Um curinga amplo aqui vira roubo de código OAuth.
  **✔ 04/09/2026 — 4 entradas, nenhum curinga amplo:**
  `sirbarbecue://auth-callback`, `sirbarbecue://reset-password` (deep links do app), `http://localhost:5173/**` e `http://192.168.0.188:5173/**` (dev).
  Não há nada como `https://*.netlify.app/**`, que seria o problema real deste item. ⏳ Quando o PWA for publicado, acrescentar a origem de produção dele. Conferir também se o painel admin precisa de entrada própria (só precisa se usar recuperação de senha ou magic link; login por senha não redireciona).

- [X] **Site URL** aponta para produção.
  **✅ CORRIGIDO em 05/09/2026** — apontado para o painel admin publicado. Registro do que estava errado e por que importava:

  **✗ Estado anterior (04/09/2026): `http://192.168.0.188:5173`**, o IP da máquina de desenvolvimento na LAN.

  A Site URL não é decorativa: é o destino padrão quando nenhuma Redirect URL casa **e** é a variável exposta nos **templates de e-mail**. Ou seja, todo link que o Auth manda — confirmação de cadastro, recuperação de senha, convite de membro — aponta hoje para um IP privado.

  **Efeito prático:** o cliente recebe o e-mail, clica, e o navegador dele tenta abrir `192.168.0.188` **na rede dele**. Vai dar erro — ou, pior, abrir o que quer que esteja naquele IP na rede daquela pessoa. Recuperação de senha e convite de funcionário estão quebrados para qualquer usuário fora da sua LAN.

  Há também um ângulo de segurança: se alguém na mesma rede do usuário controlar esse IP, o código de autenticação que viaja na URL cai no colo dessa pessoa. Exige estar na mesma LAN, então é cenário estreito — mas o defeito funcional já basta.

  **Correção aplicada:** aponta para o painel admin publicado — endereço público e alcançável, o que restaura os links de e-mail.

  ⏳ **Revisar quando o PWA for publicado:** a Site URL ideal é a do PWA, que é onde o cliente final de fato entra. Com o valor atual, quem cair no *fallback* (nenhuma Redirect URL casando) aterrissa na tela de login do painel do dono — inofensivo, já que `is_platform_admin()` barra a entrada, mas confuso. Vale lembrar que o fallback é exceção: as recuperações iniciadas pelo app usam os deep links `sirbarbecue://reset-password`, que estão nas Redirect URLs e têm precedência.
- [X] Política de senha: mínimo, `Prevent use of leaked passwords`, captcha (ver A07-01).
  **✔ 04/09/2026 — conferido. Resultado misto:**

  | Configuração | Estado | Avaliação |
  |---|---|---|
  | **Minimum password length** | **10** | ✅ **A07-01 atendido no servidor** — casa com o que os dois apps já validam |
  | Email OTP length | 8 dígitos | ✅ acima do padrão (6) |
  | Secure email change | ON | ✅ troca de e-mail exige confirmar no endereço antigo **e** no novo |
  | Email OTP expiration | 3600s | aceitável; 900–1800s seria mais apertado |
  | Password requirements | nenhuma | opcional — exigir letra+número endurece um pouco |
  | **Prevent use of leaked passwords** | **OFF** | ⚠️ **bloqueado pelo plano** — o painel informa "Only available on Pro plan and above". Não é desleixo: é indisponível no free. O item do A07-01 só se resolve migrando de plano |
  | **Secure password change** | **OFF** | 🔴 ver abaixo |
  | **Require current password when updating** | **OFF** | 🔴 ver abaixo |

  🔴 **As duas últimas, combinadas, permitem tomada de conta a partir de uma sessão aberta.** Quem estiver com o aparelho desbloqueado e logado troca a senha **sem informar a senha atual** e **sem reautenticar** — e o dono legítimo fica trancado para fora do próprio PDV.

  O cenário não é hipotético neste produto: o aparelho fica no balcão, ligado e logado, o expediente inteiro, ao alcance de funcionários e de quem passa. É a diferença entre "alguém mexeu no meu app" e "perdi o acesso à minha empresa".

  **Correção (dois cliques, sem mudança de código):** ligar **Require current password when updating** — resolve o essencial exigindo a senha atual. **Secure password change** é o reforço complementar (exige sessão criada nas últimas 24h).

  ⚠️ **Antes de ligar, verifique o fluxo de recuperação de senha**: quem chega por link de e-mail não sabe a senha atual. O Supabase trata o fluxo de recovery como reautenticado, então não deve quebrar — mas teste o "esqueci minha senha" ponta a ponta logo depois de ativar, porque quebrar a recuperação seria trocar um problema por outro pior.

  🚫 **Captcha — DECISÃO DO DONO (05/09/2026): não ativar por enquanto.** Ligá-lo agora acrescentaria atrito no acesso num momento em que a prioridade é a adoção do produto. Não é pendência: é escolha consciente, com o risco aceito.

  O que ela deixa em aberto: cadastro e login seguem protegidos apenas pelo rate limit do Auth (**30 requisições por 5 min por IP**), que barra força bruta de um mesmo endereço, mas não um ataque distribuído nem criação automatizada de contas em massa. Vale reconsiderar se aparecerem cadastros falsos ou picos anormais na tela de login.
- [X] **Bucket `reports` é privado** (`public = false`) e a policy `reports_tenant_read` está ativa: `select id, public from storage.buckets where id = 'reports';`.
  **✔ 02/09/2026 — bucket privado (`public = false`) e policy ativa**, idêntica ao script. `reports_tenant_read` é inclusive a **única** policy em `storage.objects`: nenhum cliente autenticado escreve no bucket — quem sobe o arquivo é a `generate-report` com `service_role`.
- [X] Existe rotina de limpeza dos HTMLs órfãos no bucket `reports`? (ver A01-02).
  **✗ 04/09/2026 — não existe nenhuma.** Verificado em todo o projeto: não há rotina, cron ou função que apague arquivos do bucket.

  **O que é um órfão:** a `generate-report` escreve em dois sistemas independentes — o arquivo em `reports/<tenant_id>/<id>.html` no Storage e a linha na tabela `reports`. O Postgres não apaga arquivo do Storage. Sobra arquivo sem linha quando (1) falha entre as duas etapas — era o A01-02, já corrigido no código com o INSERT antes do upload; (2) **a empresa é apagada** — o cascade some com as linhas de `reports` e deixa os arquivos; (3) relatórios são reemitidos e os antigos se acumulam.

  **O caso (2) é o que importa, e está confirmado:** `delete-account/index.ts:127-137` apaga `tenants` e `tenant_members` e **nunca toca no Storage**.

  **Consequência LGPD:** o cliente exclui a conta — que é o RNF-08, direito à eliminação — e os relatórios dele (faturamento, produtos vendidos, margem) permanecem no bucket por tempo indeterminado. A obrigação é cumprida no banco e descumprida no Storage.

  Não é risco de exposição: `reports_tenant_read` autoriza por pasta = `tenant_id`, e sem membros na empresa apagada ninguém alcança o arquivo. O problema é dado pessoal que deveria ter sido destruído e não foi.

  **✅ CORREÇÃO APLICADA em 05/09/2026** (autorizada pelo dono) — `supabase/functions/delete-account/index.ts`:
  - Nova função `deleteTenantReports(admin, tenantId)`: lista e remove `reports/<tenant_id>/*` em rodadas de 100. **Sempre lista do início**, nunca por `offset` — como cada rodada apaga o que listou, paginar por offset pularia arquivos.
  - Chamada **dentro do laço, antes** de `admin.from('tenants').delete()`. Depois do delete não há mais como saber quais pastas eram da empresa.
  - **Falha aborta tudo:** se a limpeza der erro, o `throw` sobe para o `catch` e a conta **não** é apagada. O usuário repete a exclusão — a operação é idempotente, a empresa ainda existe. É o oposto do defeito que se está corrigindo: melhor a exclusão falhar e ser refeita do que concluir deixando os relatórios para trás.
  - Teto de 100 rodadas (10.000 arquivos por empresa) para não girar infinito caso o `remove` pare de surtir efeito.

  ⚠️ **Sem verificação automatizada possível neste ambiente:** Edge Functions rodam em Deno, o `deno` não está instalado na máquina e `supabase/` está no `exclude` do `tsconfig.json`. O código foi revisado manualmente. **O teste real é excluir uma conta de teste que tenha relatórios gerados** e confirmar que a pasta sumiu do bucket. Exige `supabase functions deploy delete-account`.

  ⏳ *(opcional, não feito)* Varredura periódica de órfãos para os casos (1) e (3), comparando arquivos do bucket com os `html_url` da tabela. Volume pequeno perto do caso da conta excluída.

### Netlify

- [X] **`VITE_ACCESS_BYPASS`** não está definida, ou está `false` (A02-03).
  **✔ 05/09/2026 — não está definida, e o item se aplica a um site que ainda não existe.** A variável é do **PWA `sir-barbecue-web`**, que não tem site na Netlify (deploy ainda pendente). No site publicado — o painel admin — ela não aparece: as únicas quatro variáveis são `VITE_HEALTH_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL` e `VITE_USE_MOCK`.

  Ausente é o estado seguro: o código só desliga o gate com o valor literal `'true'`. E, para o futuro, a trava de build no `vite.config.ts` do PWA já derruba qualquer build de produção com a flag ligada (A02-03, testada). ⏳ Reconferir na primeira publicação do PWA.
- [X] **`VITE_USE_MOCK` está `false`** no site `sir-barbecue-admin`? (item acrescentado em 04/09/2026)

  **✅ 05/09/2026 — `false` nos cinco contextos de deploy** (Production, Deploy Previews, Branch deploys, Preview Server & Agent Runners, Local development). O painel nunca esteve exposto.

  **Mas a investigação encontrou uma falha de desenho, já corrigida** — o registro abaixo é o motivo de o item existir.

  **Não é só uma flag de dados falsos — ela desliga a autenticação do painel.** Em `sir-barbecue-admin/src/lib/auth.tsx:17-22`:
  ```ts
  async function checkIsAdmin(): Promise<boolean> {
    if (USE_MOCK) return true;            // qualquer visitante vira super-admin
    const { data } = await supabase.rpc('is_platform_admin');
    ...
  }
  ```
  e o `bootstrap` monta sessão falsa de dono a partir de `localStorage.getItem('mock-admin')`.

  Com `USE_MOCK` ligado em produção, `sir-barbecue-admin.netlify.app` fica **aberto a qualquer pessoa** como painel do dono. A exposição de dado real é nula (todos os hooks devolvem mock: `if (USE_MOCK) return mockTenants`), mas um painel administrativo público, com números fabricados e botões de bloqueio/cobrança aparentemente funcionais, é ruim por si só — e o próprio dono estaria decidindo sobre faturamento fictício.

  **Falha de desenho, independente do valor atual** (`src/lib/supabase.ts:7`):
  ```ts
  export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true' || !url || !anonKey;
  ```
  Credencial ausente ⇒ modo mock ⇒ **portão de admin desligado**. Uma variável esquecida num deploy futuro desativa a autenticação do painel, com um `console.warn` como único sinal. O padrão correto é o inverso: sem credencial, o painel deve **recusar-se a funcionar**.

  **✅ CORREÇÕES APLICADAS em 04/09/2026** no repositório `sir-barbecue-admin` (autorizadas pelo dono):
  1. **`src/lib/supabase.ts`** — o mock deixou de ser *fallback* e virou opt-in com **duas travas**: `USE_MOCK = import.meta.env.DEV && VITE_USE_MOCK === 'true'`. Credencial ausente não vira mais modo mock; virou `MISSING_CREDENTIALS`.
  2. **`src/main.tsx`** — com `MISSING_CREDENTIALS`, renderiza "Painel indisponível" e **não monta o `AuthProvider`**. Configuração faltando agora é parede visível, não caminho alternativo.
  3. **`vite.config.ts`** — duas travas de build de produção (mesmo padrão do `VITE_ACCESS_BYPASS` no PWA): falha se a flag de mock estiver ligada; falha se faltarem URL ou anon key.
  4. **`src/lib/auth.tsx`** — o `if (USE_MOCK) return true` foi mantido (é o que viabiliza desenvolver sem backend), com comentário explicando por que agora é inalcançável em produção.

  **Verificado:** `tsc` limpo; build com `VITE_USE_MOCK=true` **falha**; build sem credenciais **falha** com a mensagem correta; build normal passa.

  > **Escopo:** `sir-barbecue-admin` **não fez parte** desta auditoria, que cobriu o PWA `sir-barbecue-web` e o backend. Este achado saiu por acaso, ao conferir as variáveis da Netlify. O painel é o que tem acesso a dado financeiro de **todos** os clientes — merece uma passada própria.
- [ ] Após aplicar A02-01, validar os headers em produção: `curl -sI https://<dominio>/ | grep -iE 'content-security|strict-transport|x-frame|x-content-type|referrer|permissions'`.
- [ ] HTTPS forçado e certificado válido.
- [ ] Deploy previews estão desabilitados ou protegidos por senha? Um preview público expõe uma build funcional apontando para o **mesmo** Supabase de produção — e uma origem de preview não está em `ALLOWED_ORIGIN`, então as Edge Functions falharão, mas o PostgREST funcionará normalmente.

---

## 6. Pontos fortes

Listados com precisão para que ninguém remova sem perceber que era proteção.

1. **Isolamento multi-tenant no servidor, feito do jeito certo.** Toda tabela de negócio tem RLS baseada em `public.user_tenant_ids()` (`SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:73-76`), função `SECURITY DEFINER` que evita recursão de policy. As tabelas filhas isolam por `EXISTS` no pai. O `tenant_id` que o cliente envia é irrelevante para a autorização — ele só ajuda o índice. **É a decisão mais importante do sistema e está correta.**

2. **O tenant vem de `tenant_members`, não do JWT.** `src/store/authStore.ts:54-69` documenta e implementa isso, com o detalhe crítico do `.eq('user_id', userId)` (o comentário nas linhas 59-62 explica que sem ele o `.limit(1)` traria uma linha arbitrária e resolveria o papel errado). Não remova esse filtro.

3. **Correções da auditoria de julho/2026 continuam aplicadas.** O convite passa por tabela real gravada só pela Edge Function com `service_role` e validação de `owner` (`invite-member/index.ts:108-118`), `'owner'` nunca é concedido por convite (linha 102 e `MIGRATION_02_invites_table.sql:27`), o CORS é lista de origens com eco da origem que bateu e `Vary: Origin` (nunca `*`), e as triggers de estoque validam a empresa do produto (`MIGRATION_03_stock_triggers_tenant_scope.sql:33-44`).

4. **Relatório renderizado em `<iframe srcDoc sandbox="">`** (`src/screens/relatorios/Relatorios.tsx:203-208`). Documento de origem opaca, sem script e sem navegação — exatamente o contêiner certo para HTML gerado no servidor. Manter o `sandbox=""` vazio.

5. **Venda transacional e idempotente.** `create_sale` grava venda + itens + baixa de estoque numa única transação, é idempotente por `client_id` (toque duplo não vira duas vendas) e é `security invoker` de propósito — a justificativa em `MIGRATION_08_create_sale.sql:20-25` mostra que a escolha de **não** abrir um caminho `DEFINER` privilegiado foi consciente.

6. **Gate de assinatura fail-closed no cliente e sem cache local.** `src/core/rules/access.ts:46-49` nega quando o servidor não responde, e as linhas 6-13 explicam a recusa deliberada de cachear o veredito no `localStorage` — que seria um bypass trivial. É o raciocínio certo; falta apenas a contraparte no servidor (A06-01).

7. **Redação de segredos no log de erro.** `src/core/rules/errors.ts:22-41` mascara `Bearer`/`Basic`, JWTs soltos e valores de chaves sensíveis — e faz isso na **ordem correta**, com o comentário explicando por quê. Há teste cobrindo (`errors.test.ts`). Não reordene esses `.replace()`.

8. **Service worker que não cacheia dado autenticado.** Verificado no artefato compilado: uma única estratégia `CacheFirst`, para Google Fonts, e nenhuma referência ao Supabase em `dist/sw.js`. `vite.config.ts:55-57` documenta a decisão ("dado de PDV desatualizado é pior do que erro de rede").

9. **Cadeia de suprimentos limpa do lado do npm.** Zero vulnerabilidades em 506 dependências, lockfile commitado, versão do Node fixada, `sharp` isolado em devDependency.

10. **Higiene de segredos.** `.env` ignorado desde o primeiro commit, nunca versionado, `service_role` inexistente no repositório e no histórico, e `.env.example` com placeholders e instruções de configuração — inclusive avisando o que **não** fica no arquivo (Redirect URLs e `ALLOWED_ORIGIN`).

11. **Recuperação de senha à prova da corrida do PWA.** `src/main.tsx:23-30` marca a flag de forma síncrona antes de qualquer render, impedindo que a sessão criada pelo link do e-mail seja lida como login normal — armadilha real e sutil, resolvida com precisão.

12. **Endpoints públicos que não vazam nada.** `health` devolve só códigos genéricos e manda o erro real para o log (`health/index.ts:16-18, 73-85`); `health-webhook` e `send-subscription-reminder` são fail-closed por token e respondem **404** em vez de 401 para não confirmar existência a quem varre.

---

*Relatório produzido por análise estática de código-fonte em 30/08/2026. Nenhum arquivo dos projetos auditados foi modificado; nenhuma requisição foi feita ao Supabase de produção.*
