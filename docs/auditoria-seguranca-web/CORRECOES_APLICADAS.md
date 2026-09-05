# Correções de segurança — OWASP Top 10:2025

Implementação do plano da seção 4 de [AUDITORIA_SEGURANCA_OWASP_2025.md](./AUDITORIA_SEGURANCA_OWASP_2025.md).

**Data:** 31/08/2026 · **Escopo:** PWA `sir-barbecue-web` + backend Supabase compartilhado (Edge Functions, RLS, RPCs) + app Android, onde as mudanças de servidor o alcançam.

> **Nada foi aplicado em produção.** Este documento é o roteiro de aplicação. O código e as migrações estão prontos nos repositórios; rodar o SQL, publicar as funções e fazer o deploy é decisão sua.

## Decisões que você determinou

| Item | Decisão |
|---|---|
| A01-01 | `sales` **mantida como está** — a restrição de leitura foi aplicada só a fornecedor/custo. O item A01-01b (leitura histórica de venda para `employee`) foi **descartado**. |
| A02-03 | `VITE_ACCESS_BYPASS` já confirmada como `false` na Netlify. Implementada apenas a trava de build para o futuro. |
| Seção 5 | Itens de painel ficam para sua verificação posterior. Não foram tocados. |

---

## 1. O que mudou

### Banco de dados — 6 migrações novas em `docs/banco-multi-cliente/`

| Arquivo | Achado | O que faz |
|---|---|---|
| `MIGRATION_10_error_logs_tenant_check.sql` | A01-04 | `error_logs` passa a validar o `tenant_id` no INSERT e no UPDATE. Fim das linhas forjadas no log de erro de outra empresa. `tenant_id is null` continua permitido (erro antes do vínculo). |
| `MIGRATION_11_tenant_has_access.sql` | **A06-01** | Cria `tenant_has_access(uuid)` (mesma regra da `get_access_status`) e a exige nas policies de **escrita** de vendas, comandas, catálogo, estoque e fornecedor. A **leitura fica liberada** — inadimplente precisa conseguir consultar e exportar o próprio dado. |
| `MIGRATION_12_create_sale_guards.sql` | **A06-02** + A06-01 | `create_sale` passa a conferir o `unit_price` contra `products.price` (venda rápida) ou `tab_items.unit_price` (comanda), e a recusar venda de empresa sem assinatura com mensagem legível. |
| `MIGRATION_13_supplier_cost_rbac.sql` | A01-01 | Leitura de `suppliers`, `product_suppliers` e `product_supplier_price_history` restrita a `owner|manager` — espelha o que a UI já escondia do funcionário. |
| `MIGRATION_14_audit_log.sql` | A09-01 | Tabela `audit_log` append-only + triggers: exclusão e mudança de valor de venda, remoção de membro e troca de papel, exclusão de empresa, mudança de preço de venda e **divergência de preço na venda**. |
| `MIGRATION_15_sales_delete_owner_only.sql` | A01-03 | **OPCIONAL, decisão sua.** Só o owner apaga venda. Não mexe em leitura nem em INSERT/UPDATE. |

### Edge Functions — `supabase/functions/`

| Função | Achado | Mudança |
|---|---|---|
| `generate-report` | A01-02 | Checagem explícita de `owner\|manager` logo após resolver o chamador; o `INSERT` em `reports` passou a vir **antes** do upload (falha de autorização não deixa mais HTML órfão no bucket, e um upload que falha desfaz a linha). |
| `delete-account` | **A06-03** | Exige uma **prova** antes de apagar; ter a sessão do aparelho deixou de ser suficiente. Conta com senha: a senha atual, revalidada no servidor com `signInWithPassword`. Conta criada pelo **Google**: não existe senha no GoTrue para validar, então a prova é digitar o próprio e-mail (resolve toque acidental e clickjacking, que era o cenário do achado). Sem informação de `identities`, cai no caminho da senha — falha fechada. |
| `send-push` | A02-02 | CORS alinhado às demais: `ALLOWED_ORIGIN` como lista, eco só da origem que bateu, `Vary: Origin`. |
| `send-subscription-reminder` | A05-01 | `escapeHtml` no nome da empresa antes de interpolar no HTML do e-mail (+ corte em 120 caracteres). |
| `invite-member`, `delete-account`, `generate-report`, `send-push` | A10-01 | `catch` padronizado: detalhe técnico no log da função, e para o usuário uma frase genérica + `ref` de 8 caracteres. As mensagens de negócio já tratadas (e-mail faltando, "apenas o dono pode convidar") continuam específicas. |
| as 6 que usam o SDK | A03-01 | Import fixado em `@supabase/supabase-js@2.112.4` (era `@2`, que resolvia para a última 2.x a cada deploy — código que roda com a `service_role`). |

### PWA — `c:\develop\WEB\sir-barbecue-web`

| Arquivo | Achado | Mudança |
|---|---|---|
| `netlify.toml` | **A02-01** | Bloco `[[headers]] for = "/*"` com CSP, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy` e `Permissions-Policy`. |
| `index.html`, `src/index.css`, `package.json` | A08-01 | Fonte Inter autohospedada (`@fontsource/inter`, subconjunto `latin`, 4 pesos). Sem recurso de terceiro na página — a CSP fechou: nem `fonts.googleapis.com` nem `fonts.gstatic.com`. |
| `vite.config.ts` | A02-03 / A08-01 | Build de produção **falha** se `VITE_ACCESS_BYPASS=true` (testado). `runtimeCaching` do service worker esvaziado — não há mais origem externa para cachear. |
| `src/screens/conta/Conta.tsx` | A06-03 | O `window.confirm` virou painel de confirmação, com campo de senha ou de e-mail conforme o tipo da conta. |
| `src/core/rules/account.ts` (+ teste) | A06-03 | `usesPasswordLogin(user)`: decide qual campo a tela pede. Mesma regra que a Edge Function aplica no servidor. |
| `src/data/services/functions.ts` | A06-03 / A10-01 | `deleteAccount({ password? , confirmText? })`; o `ref` das funções entra na mensagem como `(cód. XXXXXXXX)`. |
| `src/screens/auth/SignUp.tsx`, `ResetPassword.tsx` | A07-01 | Mínimo de senha 6 → **10**. |

### App Android — `c:\develop\MOBILE\sir-barbecue`

Alterado porque compartilha o backend e as funções:

| Arquivo | Mudança |
|---|---|
| `app/(app)/mais/perfil.tsx` | Exclusão de conta em dois passos, com campo de senha ou de e-mail conforme o tipo da conta (`KeyboardAvoidingView` + `keyboardShouldPersistTaps`, e a tecla do teclado só fecha o teclado — gravar é no botão). |
| `src/services/auth.ts` | `usesPasswordLogin(user)` — espelho da regra do web. |
| `src/services/functions.ts` | `deleteAccount({ password?, confirmText? })` + `ref` na mensagem. |
| `app/(auth)/signup.tsx`, `app/reset-password.tsx` | Mínimo de senha 6 → 10. |

**Contas do Google.** O app entra por e-mail+senha e por Google. Um usuário que entrou só pelo Google **não tem senha no Supabase Auth** — a senha dele é do Google e nunca chega ao app. Isso não afeta o mínimo de 10 caracteres (que só roda no cadastro e na troca de senha, telas que a conta do Google nunca vê), mas afetava a exclusão de conta: exigir senha ali trancaria esse usuário fora da própria exclusão. Por isso a Edge Function tem os dois caminhos, e `usesPasswordLogin()` — a mesma regra nos dois lados — decide qual campo a tela pede.

**Verificação executada:** `typecheck` limpo nos dois projetos; 179 testes do web passando (4 novos, cobrindo `usesPasswordLogin`); `npm run build` do web OK; `eslint` limpo nos arquivos mobile alterados; a trava do `VITE_ACCESS_BYPASS` foi testada de fato (build de produção falha com a mensagem correta).

---

## 2. Ordem de aplicação

A ordem importa: as migrações têm dependência entre si, e a função `delete-account` passa a exigir um campo que só as versões novas dos apps enviam.

### Passo 1 — SQL, em ambiente de teste primeiro

No Supabase → SQL Editor, **nesta ordem**:

1. `MIGRATION_10_error_logs_tenant_check.sql` — risco baixo, pode ir direto.
2. **Antes da 11**, confirme que toda empresa tem assinatura. Sem linha em `subscriptions`, `tenant_has_access` devolve `false` e a empresa **para de escrever**:
   ```sql
   select t.id, t.name from public.tenants t
    where not exists (select 1 from public.subscriptions s where s.tenant_id = t.id);
   ```
   Tem de voltar **zero linhas**. Se voltar alguma, crie a assinatura antes de seguir.
3. `MIGRATION_11_tenant_has_access.sql`
4. `MIGRATION_12_create_sale_guards.sql` (depende da 11)
5. `MIGRATION_13_supplier_cost_rbac.sql`
6. `MIGRATION_14_audit_log.sql`
7. `MIGRATION_15_sales_delete_owner_only.sql` — **só se você decidir aplicar** (ver seção 4)

**Teste obrigatório entre o passo 3 e o 4**, num tenant de teste:
```sql
update public.subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = '<id de teste>';
```
- vender pelo PWA **e** pelo Android → as duas devem falhar;
- abrir telas de consulta e gerar relatório → devem continuar funcionando;
- restaurar o `trial_ends_at`.

### Passo 2 — Edge Functions

```bash
supabase functions deploy generate-report
supabase functions deploy send-subscription-reminder
supabase functions deploy invite-member
supabase functions deploy health
supabase functions deploy health-webhook
supabase functions deploy delete-account   # deixe por último: ver o aviso abaixo
```

> **`delete-account` é uma quebra de contrato deliberada.** A partir do deploy, a versão **antiga** do app Android (a que está no celular hoje) não consegue mais excluir conta — vai receber "Informe sua senha para confirmar a exclusão". Isso falha fechado: nada é apagado por engano. Se preferir, publique `delete-account` só depois de distribuir o APK novo.

### Passo 3 — PWA (Netlify)

Deploy normal. Depois, valide os cabeçalhos em produção:
```bash
curl -sI https://<seu-dominio>/ | grep -iE 'content-security|strict-transport|x-frame|x-content-type|referrer|permissions'
```
E, no iPhone com o app instalado (standalone), confirme:
- login, venda e comanda funcionando (a CSP libera `wss:` do Supabase para o Realtime);
- **abrir um relatório** — ele roda em `<iframe srcDoc sandbox="">` e é o único ponto que a CSP poderia afetar;
- a fonte carregando (agora vem do próprio domínio).

### Passo 4 — APK novo do Android

Necessário por causa do `delete-account` e do mínimo de senha. Sem ele, o app antigo continua operando normalmente em tudo o mais.

---

## 3. O que depende de você (painel)

Não dá para fazer por código:

- **Supabase → Authentication → Policies** (A07-01): elevar o mínimo de senha para **10** (os apps já validam 10) e ligar `Prevent use of leaked passwords`. Sem isso, o servidor continua aceitando 6 — a validação seria só do cliente, que é exatamente o padrão que esta auditoria combateu.
- **Supabase → Authentication** (A07-01): habilitar captcha (hCaptcha/Turnstile) em cadastro e login.
- Os itens da **seção 5** do relatório, que você já sinalizou que verifica depois. Um deles — conferir que as policies em produção batem com os scripts (`pg_policies`) — **já foi feito em 02/09/2026**: ver a seção 5 abaixo e [CONFERENCIA_POLICIES_PRODUCAO.md](./CONFERENCIA_POLICIES_PRODUCAO.md). Continua pendente o teste prático do Realtime das comandas com duas contas.

---

## 4. Decisões pendentes e limites conhecidos

**`MIGRATION_15` (A01-03) — aplicar ou não.** Restringe o DELETE de venda ao owner. Nenhum dos dois apps apaga venda (verificado: o web só faz SELECT em `sales`; o sync do mobile só deleta `product_day_visibility`, `product_suppliers` e `tab_items`), então o risco operacional é praticamente nulo — mas mexe numa policy de `sales`, e você pediu para tratar essa tabela com cuidado. Por isso ficou em arquivo separado.

**A07-01b (MFA obrigatório para `owner`) — não implementado.** É mudança de produto, não correção de bug: muda o fluxo de login de todo dono, exige tela de enrolment de TOTP, e um dono que perde o celular fica trancado fora do próprio PDV. Precisa da sua decisão antes de virar código.

**O caminho do Android não passa pela guarda de preço.** A `MIGRATION_12` protege a RPC `create_sale`, usada pelo PWA. O mobile é offline-first e sobe a venda pelo upsert do sync, direto em `sales`/`sale_items`. Não dá para bloquear por divergência ali: uma venda feita há três dias e sincronizada hoje legitimamente carrega o preço de três dias atrás. O controle compensatório é a trilha `sale_item.price_divergence` da `MIGRATION_14` — **registra, não bloqueia**, e dá ao dono uma lista do que revisar:

```sql
select at, action, before, after, actor_id
  from public.audit_log
 where tenant_id = '<id>' and action = 'sale_item.price_divergence'
 order by at desc;
```

Se o volume incomodar (empresa que muda preço toda semana), esse é o único trigger da `MIGRATION_14` seguro de desligar:
```sql
drop trigger trg_audit_sale_item_price on public.sale_items;
```

**Efeito colateral esperado da `MIGRATION_13`:** no aparelho de um funcionário, o custo de compra (`product_suppliers`) se autolimpa no primeiro sync — o pull reconcilia exclusões e o servidor deixa de devolver essas linhas. A exclusão é **só local**; nada some do servidor. Já `suppliers` (nome, telefone, endereço) não tem essa reconciliação: as linhas já baixadas permanecem no aparelho até uma limpeza de dados do app.

**Efeito colateral esperado da `MIGRATION_11` no offline:** se a assinatura vencer com vendas pendentes de sync no celular, o push passa a falhar e as vendas ficam retidas no SQLite local até a regularização. É o comportamento desejado, mas é bom saber antes de receber a ligação.

---

## 5. Linha de base conferida em produção — 02/09/2026

Antes de aplicar qualquer migração, o estado real do banco foi comparado policy a policy com os scripts versionados. Relatório completo em [CONFERENCIA_POLICIES_PRODUCAO.md](./CONFERENCIA_POLICIES_PRODUCAO.md).

**Resultado: nenhuma divergência.** As 31 policies de `SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` + `MIGRATION_09_tabs.sql` + `SUPABASE_SCHEMA_LICENSING.sql` batem com produção em `USING`, `WITH CHECK` e `permissive`; RLS habilitada em 26 de 26 tabelas; `reports_tenant_read` em `storage.objects` confere. As 8 policies restantes do banco vêm das MIGRATION_02 a 07, também conforme o repositório.

Isso é a pré-condição que faltava para aplicar as MIGRATION_10–15: como elas fazem `drop policy` + `create policy` sobre policies existentes, saber que o alvo é exatamente o que está versionado elimina o risco de substituir uma regra diferente da esperada.

**Dois registros que saíram da conferência:**

1. **`push_tokens.tenant_all` está com `roles = {public}`**, única policy do banco fora do padrão `to authenticated`. Não é divergência — a omissão está no próprio `MIGRATION_02_push_tokens.sql:26`. Impacto prático baixo (para o anônimo, `auth.uid()` é NULL, `user_tenant_ids()` volta vazio e a policy nega tudo). **Encaminhado por remoção** (02/09/2026): ver seção 6.

2. **A não-aplicação das MIGRATION_10–15 está comprovada pelo estado do banco**, não só pela memória do projeto: `error_logs_insert` sem a checagem de tenant (10), `sales`/`tabs` ainda com policy `FOR ALL` única e sem `tenant_has_access` (11), fornecedor e custo ainda legíveis por `employee` (13), tabela `audit_log` inexistente (14), DELETE de venda ainda aberto a qualquer membro (15).

---

## 6. Remoção da infra de push — 02/09/2026

Decisão de produto, não correção de achado: a notificação de estoque baixo pelo sistema do celular não se justifica num PDV, onde o app fica aberto o expediente inteiro e o alerta já aparece de forma clara na Home. O push era redundante e cobrava caro por isso — tabela com RLS, egress via `pg_net` a cada baixa de estoque, uma Edge Function com `service_role` e credenciais FCM no EAS. A etapa 1 (remover o ponto de entrada no app) foi feita em 20/08/2026, commit `d0f5b57`; esta é a etapa 2.

**Efeito colateral bem-vindo:** resolve o achado do `push_tokens` com `roles = {public}` por eliminação, em vez de deixá-lo mitigado.

### Ordem de aplicação

1. `supabase functions delete send-push` — a função lê `push_tokens` com `service_role` e perde o propósito sem ela.

   > **Ela não era o disparador do alerta de estoque.** Quem enviava era o trigger `notify_low_stock`, chamando a Expo Push API direto por `pg_net`. A `send-push` era um sender genérico para envios manuais, e **nunca foi ligada a nada**: nem o app mobile (`src/services/functions.ts` chama só `generate-report`, `invite-member` e `delete-account`), nem o PWA, nem o painel admin, nem `pg_cron`. Removê-la não tira funcionalidade — tira um endpoint público que roda com `service_role` sem servir a nada.
2. `docs/banco-multi-cliente/MIGRATION_16_drop_push_infra.sql` no SQL Editor: derruba o trigger `trg_notify_low_stock`, a função `notify_low_stock()` e a tabela `push_tokens` (a policy e os índices caem junto). O arquivo traz as consultas de verificação.

Invertendo a ordem nada quebra de fato — ninguém chama a função —, mas ela passaria a responder erro em vez de deixar de existir.

### O que NÃO sai

- **A extensão `pg_net`.** Ela não é exclusiva do push: `send_subscription_due_reminders()` usa `net.http_post` para o lembrete de vencimento. Dropar quebraria a cobrança.
- **O alerta de estoque.** `stock_items.alert_threshold` e a seção "Alertas de estoque" da Home continuam intactos — o que sai é o canal de push, não o aviso.

### Pontos verificados

- **APKs antigos em campo não quebram.** Um app anterior ao `d0f5b57` ainda tenta gravar o token no boot. Com a tabela fora, o upsert falha e `registerAndSavePushToken` devolve `{ token, error }` — mas o chamador em `app/_layout.tsx` era `void registerAndSavePushToken(...)`, que descarta o retorno, e a função nunca lança. Falha em silêncio, sem crash e sem mensagem. **Não é preciso distribuir APK novo por causa disto.**
- **`MIGRATION_02_push_tokens.sql` é idempotente e recriaria tudo.** Ganhou um aviso de OBSOLETA no cabeçalho; ficou no repositório só como registro histórico. Mesma armadilha do `handle_new_user` descrita em [CONFERENCIA_POLICIES_PRODUCAO.md](./CONFERENCIA_POLICIES_PRODUCAO.md).
- **A correção A02-02 (CORS da `send-push`) deixa de ter destino.** Ela estava escrita e não publicada; com a função removida, o item se encerra por eliminação. A linha `supabase functions deploy send-push` saiu da lista de deploy da seção 2.

### Pendente de decisão sua

O pacote `expo-notifications` (`package.json`) e o plugin correspondente em `app.json` continuam no projeto, agora sem nenhum código que os use. Removê-los enxuga o bundle e tira do APK as permissões de notificação — bom para a ficha da Play Store —, **mas mexe na configuração nativa: exige `expo prebuild` e um APK novo**. Como nada depende deles hoje, dá para deixar para a próxima release em que já houver outro motivo de gerar build.
