# Auditoria complementar — BOLA/IDOR, Rate Limit/DoS, Imutabilidade de logs, Defesa em profundidade

**Data:** 12-13/09/2026 · **Escopo:** app mobile (`c:\develop\MOBILE\sir-barbecue`), PWA web
(`c:\develop\WEB\sir-barbecue-web`), backend Supabase compartilhado (RLS, RPCs, Edge Functions).

> Levantamento feito em 12-13/09/2026 (3 sub-investigações paralelas + verificação manual de todo
> achado, inclusive uma correção a um achado inicial que estava errado — seção 1, nota no fim).
> **Status (13/09/2026): os 3 gaps de BOLA da seção 1 foram corrigidos** — ver
> `docs/banco-multi-cliente/MIGRATION_23_cross_tenant_child_refs.sql`. Rate limit e hash-chain de
> log (seções 2 e 3) ficam como estão por decisão do dono — ver justificativa no fim de cada seção.

---

## 1. BOLA / IDOR (Broken Object Level Authorization / Insecure Direct Object Reference)

### O que está PROTEGIDO

**RPCs com parâmetro de id**: nenhuma vaza dado ou aceita ação sobre objeto de outro tenant sem
validar posse primeiro.
- `get_access_status(p_tenant_id)` e `bind_device(...)` — checam `p_tenant_id in (select user_tenant_ids())` antes de tocar em `subscriptions`/`tenant_devices` (`docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql:229`, `:299`).
- Todas as `admin_*` — gated por `is_platform_admin()` antes de usar qualquer id recebido.
- `delete_tenant_cascade(p_tenant_id)` — `revoke ... from public, anon, authenticated`, só `service_role` chama, e o id vem de `owner_user_id = user.id` do JWT (nunca do corpo da requisição) em `supabase/functions/delete-account/index.ts`.
- `create_sale(...)` — `security invoker` (roda com a RLS do chamador, não com privilégio elevado); a guarda de preço da MIGRATION_12 ainda confere `products.tenant_id = p_tenant_id`.

**Edge Functions**: `generate-report`, `export-company-data` e `invite-member` usam o mesmo padrão (`getCallerTenant`/`resolveCaller`): se o corpo trouxer `tenant_id`, é validado contra `user_tenant_ids()` do **JWT do chamador** antes de aceitar; sem isso, cai num fallback pela própria filiação. `delete-account` nunca aceita id de tenant do corpo.

**Storage / Signed URLs**: `reports_tenant_read` e `exports_tenant_owner_read` usam `(storage.foldername(name))[1]` como candidato a tenant_id, mas SEMPRE revalidado contra `auth.uid()` real via `is_tenant_owner[_or_manager]()` no momento da assinatura da URL. Forjar o path de outro tenant na URL não funciona — a policy reavalia posse real, não confia no path.

### GAP real, impacto BAIXO — tabelas filhas com duas referências por `client_id`

Quando uma linha referencia dois objetos de negócio (ex.: comanda+produto, entrada de estoque+fornecedor), a policy valida a posse de só UM dos lados:

| Tabela | Campo não validado | Policy que faltou o check | Impacto real |
|---|---|---|---|
| `tab_items` | `product_client_id` | `tab_items_write` (`MIGRATION_11_tenant_has_access.sql:148-156`) | **Nenhum dano concreto.** Se o item de comanda referenciar produto de outro tenant e a comanda for fechada em venda, o `INSERT` em `sale_items` dispara `deduct_stock_on_sale`, que JÁ rejeita produto de outro tenant (ver correção abaixo). Só causa poluição da comanda em si, nunca chega a mexer em estoque alheio. |
| `stock_entries` | `supplier_client_id` | escrita via loop dinâmico (`MIGRATION_11_tenant_has_access.sql:162-174`) | Baixo — não vaza dado de fornecedor (leitura de `suppliers` já isolada por tenant), só cria referência cruzada "pendurada" num registro de entrada de estoque. |
| `product_suppliers` | `supplier_client_id` | `product_suppliers_write` (`MIGRATION_11_tenant_has_access.sql:194-203`) | Baixo — mesma razão; polui `product_supplier_price_history` com uma linha misturando produto de A e fornecedor de B, sem vazar dado de B. |

**✅ Corrigido em 13/09/2026** — `docs/banco-multi-cliente/MIGRATION_23_cross_tenant_child_refs.sql`
acrescentou o `exists` faltante nas 3 policies acima, checando que o segundo `..._client_id`
pertence ao mesmo tenant do primeiro (mesmo padrão que `deduct_stock_on_sale`/
`increment_stock_on_entry` já usam a nível de trigger). Sem impacto no uso legítimo — os seletores
de produto/fornecedor na UI já só listam itens do próprio tenant, então nenhum fluxo real do app
gerava essas combinações; só uma requisição forjada fora da UI chegava nelas.

### ⚠️ Correção a um achado inicial (registrado aqui de propósito, pra não se repetir)

Uma primeira passada apontou que `sale_items.product_client_id` **não** era validado contra o tenant
da venda, e que isso permitiria um usuário do tenant A inserir um item de venda referenciando
produto do tenant B e decrementar o estoque de B via `trg_deduct_stock_on_sale` — seria o achado
mais grave desta seção. **Isso está errado.** A investigação inicial leu a versão ANTIGA da função
no schema base (`SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:324-331`, sem guarda), não a versão vigente.

A versão que está de fato aplicada em produção desde 26/07/2026
(`docs/banco-multi-cliente/MIGRATION_03_stock_triggers_tenant_scope.sql:19-46`) já resolve o tenant
da venda-pai e **recusa com exceção** (`raise exception 'produto de outra empresa no item de venda
(cross-tenant)'`) qualquer item referenciando produto de outro tenant, e ainda escopa o `UPDATE` de
`stock_items` por `tenant_id`. O mesmo vale para `increment_stock_on_entry`
(`MIGRATION_03_stock_triggers_tenant_scope.sql:49-65`), que valida `product_client_id` contra
`stock_entries.tenant_id` e escopa o `ON CONFLICT DO UPDATE` pelo tenant também. Essa classe de
problema (achado C-1/estoque cross-tenant da auditoria de 07/2026,
[[project-security-remediation-2026-07]] na memória do projeto) **já estava corrigida** antes desta
auditoria começar — foi uma leitura de arquivo desatualizado, não uma regressão. Fica registrado
aqui como lembrete do mesmo tipo de armadilha já documentado em
`CONFERENCIA_POLICIES_PRODUCAO.md` (schema base idempotente carregando função antiga se rodado de novo).

---

## 2. Rate limit / proteção contra DoS

**Não existe rate limiting próprio em nenhuma camada do projeto** — nem Edge Functions, nem
`netlify.toml`, nem configuração de Cloudflare (não há nenhum arquivo de config do Cloudflare
versionado no repositório; se existe proteção de borda, ela vive só no painel, fora do que este
repositório permite auditar).

| Função | Situação |
|---|---|
| `generate-report` | Sem limite de chamadas. Só tem teto de 1 ano no intervalo de datas (`index.ts:157,164-166`) — mitiga janela gigante, não repetição. |
| `export-company-data` | Sem limite de chamadas. O teto de 1 ano só se aplica **quando `from`/`to` são informados** (`index.ts:145-160`) — sem informar (o padrão), processa o histórico inteiro sem limite de volume. |
| `invite-member` | Sem limite de convites por período. |
| `delete-account` | Ação autolimitada (cada um só apaga a própria conta) — risco de DoS por repetição é baixo. |
| `health` | Único caso com mitigação: cache de 5s em memória (`CACHE_MS = 5_000`, `index.ts:25`) que amortece rajada, mas não bloqueia nem devolve 429 — é cache, não rate limit. |
| `health-webhook` | Sem contador; dedupe por constraint única é idempotência de webhook, não rate limit. |

**Client-side**: o botão de "Gerar relatório"/"Exportar dados"/"Convidar membro" fica desabilitado
**durante** o carregamento (mobile e web, mesmo componente `Button` espelhado — evita duplo-clique),
mas reabilita assim que a resposta chega, sem cooldown. É contornável trivialmente chamando a Edge
Function fora da UI.

**Rate limit real confirmado**: só o nativo do Supabase Auth (30 tentativas/5min de login/cadastro
por IP) — não cobre a Data API/RPC/Edge Functions, só o Auth. A auditoria anterior já havia
confirmado isso (`AUDITORIA_SEGURANCA_OWASP_2025.md`, verificado em 03/09/2026: "esse ajuste NÃO
EXISTE. O Supabase limita as rotas do Auth [...], não as do PostgREST").

**Nota lateral que vale registrar**: o limite de 2 e-mails/hora do SMTP embutido do Supabase Auth
(mitigado apontando pra Resend, ver [[project-policies-producao-conferidas]]) não afetava só convite
— `signUp`, reenvio de confirmação de e-mail e `resetPasswordForEmail` (em `src/services/auth.ts`
mobile e equivalente web) também passam pelo SMTP do Auth. Já resolvido pela troca de SMTP, mas o
alcance real do problema era maior do que só o fluxo de convite.

**Correção desenhada, mas NÃO implementada por decisão do dono (13/09/2026)**: um throttle simples
por `(function_name, tenant_id)` nas duas functions mais caras (`export-company-data`,
`generate-report`) — uma tabela com timestamp da última chamada, checada no início da function antes
de fazer qualquer trabalho (cooldown fixo, ex. 1 chamada a cada 5min, é suficiente — são ações
manuais disparadas por humano, não uma API pública sob ataque; não precisa de token bucket/janela
com contagem).

**Decisão**: medir antes de proteger. O uso ainda é baixo (início de operação), e o Supabase já
oferece esse monitoramento pronto, sem precisar construir nada:
- **Project → Reports/Usage**: egress, tamanho do banco, invocações de Edge Function e compute ao
  longo do tempo.
- **Edge Functions → `export-company-data`/`generate-report` → Logs**: lista cada chamada
  individual — dá pra ver na hora se alguém está martelando o botão.
- O Supabase manda **e-mail automático de alerta** ao se aproximar dos limites do plano, então nem
  precisa checar manualmente com frequência.

Gatilho pra implementar o throttle acima: uso repetido visível nesses relatórios, ou o e-mail de
alerta do Supabase chegando. Até lá, fica só documentado aqui.

---

## 3. Imutabilidade e não-repúdio dos logs

| Tabela | Policy de escrita para cliente | Veredito |
|---|---|---|
| `audit_log` | Nenhuma (nem INSERT, nem UPDATE, nem DELETE) — só a função `security definer` `audit_write`, sem `grant execute` pra `authenticated`/`anon` (`MIGRATION_14_audit_log.sql:47-78`) | **Imutável contra qualquer cliente.** |
| `error_logs` | Tem policy de UPDATE que permite ao autor reescrever a PRÓPRIA linha (`user_id = auth.uid()`, `MIGRATION_05_error_logs.sql:61-67`, mantida em `MIGRATION_10_error_logs_tenant_check.sql:32-42`) | **Não é imutável** — decisão deliberada (upsert idempotente do app offline-first reenviando após falha de rede), não é bug, mas quem gerou um erro pode editar seu próprio registro depois. |
| `health_events` | Nenhuma policy de escrita nem de INSERT pra `authenticated` — só `service_role` grava (`MIGRATION_07_health_events.sql:52-53`) | **Mais restrita ainda que `audit_log`.** |

**Nenhuma das três tem hash-chain, assinatura (HMAC) ou envio a um sistema externo imutável
(WORM/SIEM/object lock).** Busca ampla no repositório não encontrou nenhuma menção real a essas
técnicas — só ocorrências de "hash"/"assinatura" em contextos não relacionados a log.

**Limitação real, não corrigível só com RLS**: a proteção documentada acima é só contra o CLIENTE
comum. Um `service_role` (usado pelas próprias Edge Functions) ou alguém com acesso de superusuário
ao Postgres (SQL Editor do Supabase, que roda como `postgres` e pula toda RLS — o mesmo fato usado
nos testes de bypass desta sessão) PODE alterar ou apagar linhas de `audit_log`/`health_events` sem
deixar rastro técnico disso. Isso não está mitigado em lugar nenhum hoje. Não é uma falha
introduzida por código — é uma limitação estrutural de qualquer sistema sem hash-chain/WORM —, mas
também nunca foi documentada como risco aceito até agora.

**Se um dia isso importar de verdade** (ex.: exigência contratual/jurídica de não-repúdio forte):
alternativas incluem encadear um hash de cada linha com a anterior (detecta adulteração/remoção
sem impedir), ou replicar `audit_log` pra um destino write-only fora do controle de quem administra
o Postgres (ex.: um bucket com object lock, ou um serviço de log externo).

---

## 4. Defesa em profundidade

Verificado em 3 fluxos sensíveis: "se a camada mais externa (UI) fosse completamente removida ou
contornada, o sistema continuaria protegido só pelas camadas de trás?"

### a) Exportar dados da empresa
1. UI esconde o botão/menu (`canAccessExport = isOwner`, `src/lib/permissions.ts`).
2. Edge Function checa `role === 'owner'` ANTES de qualquer query de dado (`export-company-data/index.ts:132-140`).
3. RLS independente: `data_exports_owner_access`, `payments_tenant_owner_read` e `exports_tenant_owner_read` (`MIGRATION_22_export_infra.sql`) bloqueiam mesmo que as camadas 1-2 falhassem — o INSERT em `data_exports` e a leitura de `payments`/download do zip passam pelo client do PRÓPRIO usuário, não por `service_role`.

**Veredito: 3 camadas reais e independentes.**

### b) Exclusão de conta
1. UI com formulário de confirmação (`app/(app)/mais/perfil.tsx`).
2. Edge Function exige reautenticação — senha (`signInWithPassword`) ou confirmação por e-mail digitado, conforme o tipo de conta (`delete-account/index.ts:152-176`).
3. **Não existe nenhuma policy de DELETE na tabela `tenants` em todo o repositório** — um `DELETE` direto via API seria negado pelo Postgres mesmo pulando a Edge Function inteira. `delete_tenant_cascade` também tem `EXECUTE` revogado de `authenticated`/`anon`.

**Veredito: 3 camadas, a última (RLS/grant no banco) genuinamente independente da function.**

### c) Bloqueio por assinatura vencida
1. UI (`AccessBlocked`/`access.ts`) bloqueia a navegação inteira quando o veredito do servidor é negativo.
2. RLS de escrita (`tenant_has_access()`, `MIGRATION_11_tenant_has_access.sql`) bloqueia toda escrita de negócio no banco — o próprio comentário da migração documenta o cenário de bypass via `curl` direto que ela corrige, e nós reproduzimos esse teste nesta sessão com sucesso (403 real). Leitura fica liberada de propósito (LGPD), não é falha da camada.

**Veredito: 2 camadas independentes, testado ao vivo.**

**Conclusão geral**: nos 3 fluxos mais sensíveis do produto, a defesa em profundidade é real — não é
a mesma checagem repetida, cada camada continua protegendo mesmo com as anteriores completamente
removidas.

---

## Resumo para decisão

| Item | Situação | Ação | Status |
|---|---|---|---|
| BOLA `tab_items`/`stock_entries`/`product_suppliers` (3 tabelas) | Gap real, impacto baixo | Acrescentar `exists` nas policies | **✅ Corrigido 13/09/2026** — `MIGRATION_23_cross_tenant_child_refs.sql` |
| BOLA `sale_items`/estoque cross-tenant | **Já corrigido** desde 07/2026 | Nenhuma (registrado só pra não reabrir a dúvida) | — |
| Rate limit nas Edge Functions caras | Ausente | Throttle simples por tenant/function, desenhado mas não implementado | **Decisão 13/09/2026: manter monitorando via Reports/Usage do Supabase**; implementar só se o uso justificar |
| `error_logs` editável pelo autor | Decisão deliberada, não bug | Nenhuma, ou aceitar formalmente como risco conhecido | Mantido como está |
| `audit_log`/`health_events` sem hash-chain | Limitação estrutural | Só relevante se houver exigência de não-repúdio forte | **Decisão 13/09/2026: mantido como está** — complexidade não compensa pro tamanho atual do projeto |
| Defesa em profundidade | OK nos 3 fluxos testados | Nenhuma | — |

Pendente: rodar `MIGRATION_23_cross_tenant_child_refs.sql` no Supabase (escrita, ainda não aplicada
no banco de produção) e confirmar os testes funcionais no fim do arquivo.
