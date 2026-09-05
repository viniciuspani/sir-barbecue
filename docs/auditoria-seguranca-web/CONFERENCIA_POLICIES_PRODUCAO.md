# Conferência das policies em produção × scripts SQL

**Data:** 02/09/2026 · **Projeto Supabase:** `ltwaotffsxbxkeydwoxm` (banco compartilhado pelo app Android e pelo PWA)

Atende ao item da seção 3 de [CORRECOES_APLICADAS.md](./CORRECOES_APLICADAS.md): *"conferir que as policies em produção batem com os scripts (`pg_policies`) — porque estas migrações substituem policies existentes"*. A conferência foi feita **antes** de aplicar as MIGRATION_10–15, justamente para ter a linha de base contra a qual comparar depois.

## Escopo

Scripts conferidos linha a linha contra o estado real do banco:

- `docs/banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` — 23 policies em `public` + 1 em `storage`
- `docs/banco-multi-cliente/MIGRATION_09_tabs.sql` — 2 policies
- `docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql` — 6 policies

**Total conferido: 31 policies em `public` + 1 em `storage.objects`.**

Consultas usadas:

```sql
-- 1) policies do schema public (regra completa: using + with check + papéis)
select tablename, policyname, cmd, permissive, roles, qual, with_check
  from pg_policies where schemaname = 'public' order by tablename, policyname;

-- 2) RLS realmente habilitada (pg_policies lista policy mesmo com RLS desligada)
select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relrowsecurity, c.relname;

-- 3) policies do storage
select policyname, qual, with_check from pg_policies where schemaname = 'storage';
```

## Resultado

| Verificação | Resultado |
|---|---|
| 31 policies dos 3 scripts × produção — expressão `USING` (`qual`) | ✅ idênticas |
| `WITH CHECK` das 14 policies `FOR ALL` + `tenant_owner_write` | ✅ idênticas |
| `permissive` | ✅ todas `PERMISSIVE` — nenhuma `RESTRICTIVE` oculta cortando acesso |
| `roles` | ⚠️ `{authenticated}` em 38 de 39; exceção: `push_tokens` (`{public}`) |
| RLS habilitada | ✅ 26 de 26 tabelas |
| `storage.objects` → `reports_tenant_read` | ✅ confere |

**Nenhuma divergência entre os três scripts e produção.** O banco está exatamente no estado "3 scripts base + MIGRATION_02 a 07".

### Detalhe por script

**SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql** — 23/23 conferem:

| Tabela | Policies | Regra |
|---|---|---|
| `tenants` | `tenant_member_select` (SELECT), `tenant_owner_write` (UPDATE) | membro lê; só owner altera cadastro |
| `tenant_members` | `members_select`, `members_manage` (ALL) | membro vê equipe; só owner gerencia |
| `sales`, `sync_checkpoints` | `tenant_all` (ALL) | todo membro opera |
| `sale_items` | `tenant_all` (ALL) | isola pela venda-pai (`EXISTS`) |
| `categories`, `products`, `stock_items`, `stock_entries` | `*_select` + `*_write` | leitura membro; escrita `owner\|manager` |
| `product_day_visibility` | `pdv_select`, `pdv_write` | idem catálogo, via `EXISTS` no produto |
| `suppliers` | `suppliers_select`, `suppliers_write` | leitura membro; escrita só `owner` |
| `product_suppliers` | `product_suppliers_select`, `product_suppliers_write` | idem, via `EXISTS` no produto |
| `product_supplier_price_history` | `tenant_select` | somente leitura (quem escreve é a trigger `SECURITY DEFINER`) |
| `reports` | `reports_access` (ALL) | só `owner\|manager` |

**MIGRATION_09_tabs.sql** — `tabs.tenant_all` e `tab_items.tenant_all` (via `EXISTS` na comanda-pai): ✅ 2/2.

**SUPABASE_SCHEMA_LICENSING.sql** — ✅ 6/6: `platform_admins.admin_all`, `subscriptions_member_read` + `subscriptions_admin_all`, `tenant_devices_admin_all`, `payments_admin_all`, `app_expenses_admin_all`.

### As 8 policies restantes do dump

Produção tem 39 policies em `public`. As 8 que não vêm dos três scripts são das migrações anteriores, todas já aplicadas e coerentes com o que está versionado:

| Tabela | Policies | Origem |
|---|---|---|
| `error_logs` | 4 (`insert`, `update`, `select`, `delete`) | `MIGRATION_05_error_logs.sql` |
| `health_events` | `health_events_admin_read` | `MIGRATION_07_health_events.sql` |
| `platform_settings` | `platform_settings_admin_all` | `MIGRATION_03_price_history_cleanup_admin.sql` |
| `push_tokens` | `tenant_all` | `MIGRATION_02_push_tokens.sql` |
| `tenant_invites` | `invites_select` | `MIGRATION_02_invites_table.sql` |

39 = 31 (três scripts) + 8. A contagem fecha: não há policy em produção sem script correspondente no repositório, nem policy no repositório faltando em produção.

### RLS habilitada — 26/26

Todas as tabelas de `public` com `relrowsecurity = true`. Não há policy órfã (policy sobre tabela destravada, que não filtra nada) nem tabela com RLS ligada e nenhuma policy (que ficaria fechada para todo mundo). A contagem também fecha: 21 tabelas dos três scripts + 5 das migrações 02–07.

**`relforcerowsecurity = false` em todas é o esperado, não um achado.** Esse flag só altera o comportamento para o *dono* da tabela (`postgres`). O PostgREST atende os apps pelo papel `authenticator`, que assume `anon`/`authenticated` — nunca donos, portanto sempre sujeitos à RLS. Ligar `FORCE` inclusive quebraria o desenho: as funções `SECURITY DEFINER` do schema (`user_tenant_ids`, `is_tenant_owner`, `is_platform_admin`, os triggers de estoque, `create_sale`) dependem de rodar como dono para não recursar na própria RLS.

### `storage.objects`

```
reports_tenant_read
qual: ((bucket_id = 'reports') AND is_tenant_owner_or_manager(((storage.foldername(name))[1])::uuid))
```

Idêntica ao script. Dois pontos de projeto que vale ter registrados:

- `with_check` nula está correto — é policy de SELECT.
- É a **única** policy em `storage.objects`. Nenhum cliente autenticado grava, sobrescreve ou apaga arquivo no bucket; quem escreve é a Edge Function `generate-report` com `service_role`, que passa por cima da RLS. É intencional — e é a explicação a consultar caso algum dia um upload feito pelo app falhe em silêncio.

## Fora do alcance dos dumps: triggers em `auth.users`

As três consultas acima só enxergam os schemas `public` e `storage`. A `MIGRATION_02_invites_table.sql` — a correção do escalonamento de privilégio cross-tenant — tem sua parte crítica em **`auth.users`**: as funções `handle_new_user` (reescrita para não criar empresa própria quando existe convite pendente) e `handle_new_user_invite` (resolve o vínculo pela tabela `tenant_invites`, ignorando o metadado do signup). A tabela e a policy `invites_select` existirem não provam que os triggers foram atualizados.

Verificado à parte em 02/09/2026:

```sql
select t.tgname, t.tgenabled, p.proname
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
 order by t.tgname;

select proname, prosrc like '%tenant_invites%' as usa_tabela_de_convites
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('handle_new_user', 'handle_new_user_invite');
```

✅ Os dois triggers presentes e habilitados (`tgenabled = 'O'`), e as duas funções referenciando `tenant_invites`. A MIGRATION_02 está aplicada por inteiro: o vínculo do convidado vem da tabela de convites, e `raw_user_meta_data->>'invited_to_tenant'` — controlável pelo cliente com a anon key pública — não decide mais nada.

Na mesma linha, `deduct_stock_on_sale` foi verificada e **contém a guarda cross-tenant** da MIGRATION_03 (`prosrc` menciona o produto de outra empresa no item de venda), e `platform_admins` tem **uma única linha** — só o dono da aplicação.

### Risco de regressão silenciosa — vale para DUAS correções de segurança

`SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` é idempotente e convida a ser rodado de novo. O problema é que ele contém as versões **antigas** de duas funções que migrações posteriores endureceram — e `create or replace` sobrescreve sem erro, sem aviso e sem deixar rastro:

| Função | Versão no schema base | Versão correta em produção |
|---|---|---|
| `handle_new_user` (linha 615) | cria empresa própria sempre; confia no metadado do signup | MIGRATION_02: só cria empresa se **não** houver convite pendente |
| `deduct_stock_on_sale` (linhas 324-331) | deduz estoque sem validar a empresa do produto | MIGRATION_03: recusa produto de **outra empresa** no item de venda |

Reexecutar o schema base reabre, de uma vez, o escalonamento de privilégio cross-tenant no cadastro **e** o acesso cross-tenant ao estoque. As duas correções foram verificadas como presentes em 02/09/2026 — e as duas são reversíveis por um `Run` distraído no SQL Editor.

**Mitigação aplicada (02/09/2026):** o `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` ganhou um cabeçalho de "NÃO REEXECUTE EM PRODUÇÃO", nomeando as duas funções, o que cada uma reabre e a ordem de recuperação caso a reexecução aconteça mesmo assim.

Vale a mesma ressalva para as MIGRATION_13 e 15 depois de aplicadas: elas substituem policies que o schema base recria.

**Regra prática: depois de qualquer reexecução do schema base, rodar de novo a MIGRATION_02, a 03 e todas as posteriores, na ordem, e repetir esta conferência.**

## Realtime das comandas: RLS aplicada também em `tab_items`

As policies existirem não garante que o **Realtime** as respeite: ele avalia a RLS por linha para cada assinante, e o caso documentado como frágil é o de policy que referencia outra tabela — exatamente o de `tab_items`, que isola por `EXISTS` na comanda-pai.

Testado empiricamente em 03/09/2026, com duas empresas reais no PWA e inspeção dos frames do WebSocket (DevTools → Network → Socket → aba Messages, filtro `"record"`):

1. **Controle positivo** — item alterado dentro da mesma empresa: frame recebido, com `"table":"tab_items"` e o `record` completo. Prova que o canal entrega.
2. **Cross-tenant em `tabs`** — comanda criada na outra empresa: silêncio.
3. **Cross-tenant em `tab_items`** — itens lançados na outra empresa: silêncio.

**Isolamento confirmado no caminho de risco.** Não foi preciso `filter: 'tenant_id=eq.<id>'` no canal nem desnormalizar `tenant_id` em `tab_items`.

Detalhe metodológico que vale guardar: **o teste não pode ser feito pela tela.** Os dois clientes ignoram o payload do evento e apenas refazem a consulta via PostgREST (`sir-barbecue-web/src/data/queries/tabs.ts:40-47`; `src/data/sync/tabsLive.ts:40-47` no app nativo), que reaplica a RLS — então um evento vazado nunca renderizaria, e a tela pareceria correta de qualquer forma. O vazamento, se existisse, estaria nos frames do socket. Protocolo completo na seção 5 de [AUDITORIA_SEGURANCA_OWASP_2025.md](./AUDITORIA_SEGURANCA_OWASP_2025.md).

## Achado: Custom Access Token Hook ligado e inerte

O hook `add_tenant_claims` estava **habilitado** em produção, mas injetando `"tenant_ids": []` — array vazio para todo usuário, inclusive donos de empresa, em tokens recém-emitidos.

**Causa:** a função estava sem `security definer`. Ela executa como `supabase_auth_admin`, e o `grant select on public.tenant_members` que o schema faz resolve a permissão de **tabela** — não a **RLS**. As policies de `tenant_members` são `to authenticated`, papel que `supabase_auth_admin` não tem, e ele não tem bypass (`rolbypassrls = false`, `rolsuper = false`). Nenhuma policy se aplicava, a RLS negava tudo, o `jsonb_agg` agregou zero linhas. Nada falhava — o claim existia, só chegava vazio.

É a mesma classe de armadilha do `push_tokens` com `roles = {public}`: **a proteção parecia estar em pé e o comportamento correto vinha por acidente.** Aqui o acidente foi favorável — com `[]`, as Edge Functions descartavam o claim e consultavam `tenant_members` ao vivo, que é o certo.

**Encaminhamento (03/09/2026):** hook **desligado** (nada dependia dele; e um hook na emissão de token derruba o login de todos se lançar exceção), clientes passando a enviar `tenant_id` explicitamente, e a função corrigida no schema com `security definer` para quem um dia religar. O bloco "VARIANTE RÁPIDA" do schema — que sugeria trocar as policies por leitura do claim — virou aviso: com o hook desligado, adotá-lo faria toda consulta voltar vazia, sem erro visível.

Protocolo e evidências na seção 5 de [AUDITORIA_SEGURANCA_OWASP_2025.md](./AUDITORIA_SEGURANCA_OWASP_2025.md).

## Achado: `push_tokens` com `roles = {public}`

Única policy do banco fora do padrão `to authenticated`:

```json
{ "tablename": "push_tokens", "policyname": "tenant_all", "roles": "{public}" }
```

Não é divergência entre script e produção — o banco reproduziu fielmente o arquivo. A omissão está no próprio script, em `MIGRATION_02_push_tokens.sql:26`, que cria a policy sem a cláusula `to authenticated` presente em todas as outras.

**Impacto prático: baixo.** O papel `public` inclui `anon`, mas numa requisição anônima `auth.uid()` é NULL, `user_tenant_ids()` devolve conjunto vazio e `tenant_id IN (vazio)` é falso — o anônimo lê e escreve zero linhas. A regra de tenant continua sendo a barreira efetiva.

### Encaminhamento (02/09/2026): remoção, não correção

A decisão foi **remover a infra de push** em vez de ajustar a policy — a notificação de estoque pelo sistema do celular é redundante num PDV, onde o app fica aberto o expediente inteiro e o alerta já aparece na Home. Com a tabela fora, o achado deixa de existir em vez de ficar mitigado.

Escrita a `docs/banco-multi-cliente/MIGRATION_16_drop_push_infra.sql`: derruba `push_tokens`, o trigger `trg_notify_low_stock` e a função `notify_low_stock()`. A extensão `pg_net` **fica** — o lembrete de vencimento de assinatura depende dela. A Edge Function `send-push` sai junto (`supabase functions delete send-push`), por perder a única fonte de tokens.

Se um dia a decisão se inverter, a policy correta é esta — a versão do script original omitia o `to authenticated`:

```sql
create policy tenant_all on public.push_tokens for all to authenticated
  using      (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));
```

## Confirmação: MIGRATION_10 a 15 não estão em produção

A conferência prova, pelo estado real do banco, o que `CORRECOES_APLICADAS.md` registra como pendente:

| Migração | Evidência em produção |
|---|---|
| **10** — `error_logs` valida tenant | `error_logs_insert` está com `with_check` só de `(user_id = auth.uid())`; falta o `and (tenant_id is null or tenant_id in (...))`. Idem `error_logs_update`. |
| **11** — `tenant_has_access` | `sales`, `sale_items`, `tabs`, `tab_items` continuam com uma única policy `FOR ALL` sem a checagem de assinatura; não existe o par `*_select` / `*_write`. |
| **13** — custo/fornecedor só `owner\|manager` | `suppliers_select`, `product_suppliers_select` e `product_supplier_price_history.tenant_select` ainda usam `user_tenant_ids()` — todo membro, inclusive `employee`, lê fornecedor e preço de compra. |
| **14** — trilha de auditoria | A tabela `audit_log` **não existe** na lista de relações de `public`. |
| **15** — DELETE de venda só do owner | `sales.tenant_all` segue `FOR ALL`, o que inclui DELETE para qualquer membro. |

A **MIGRATION_10** é a que eu aplicaria primeiro: o `with_check` atual permite a qualquer usuário autenticado gravar log carimbado com o `tenant_id` de outra empresa, e esse conteúdo forjado aparece no painel de erros do dono daquela empresa (achado A01-04).

## Conclusão

Os três scripts SQL são um retrato fiel do que está publicado. Isso é a pré-condição que faltava para aplicar as MIGRATION_10–15 com segurança: como elas fazem `drop policy` + `create policy` sobre policies existentes, saber que o alvo em produção é exatamente o que está versionado elimina o risco de a migração substituir uma regra diferente da que o autor tinha em mente.

**Para repetir a conferência depois de aplicar as migrações**, rode de novo as três consultas do início e compare com o esperado da tabela acima — os itens da seção "Confirmação" devem, aí sim, aparecer invertidos.
