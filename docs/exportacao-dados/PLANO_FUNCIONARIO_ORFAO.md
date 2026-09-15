# Funcionário órfão — a empresa foi excluída e ele ficou sem saída

## Contexto

Descoberto em 15/09/2026, no teste real da exclusão agendada. A empresa "Espetinho Pani" foi
excluída; o funcionário `chapeudepalhadeath@gmail.com` **continua com a conta viva** — e isso está
certo: ele é o titular dos dados pessoais dele, e a empresa não tem o direito de apagar a conta de
outra pessoa. O problema é o que sobrou para ele.

**O que acontece hoje:**

1. `tenant_members.tenant_id … on delete cascade` ([SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql:89](docs/banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql#L89))
   **hard-deleta** a linha dele junto com a empresa. Não sobra nem `removed_at` — nenhum rastro.
2. `resolveMembership` vê 0 linhas → `membershipStatus = 'none'` e **apaga o cache local**
   ([authStore.ts:85](src/store/authStore.ts#L85)), destruindo a última pista de que existiu uma empresa.
3. O gate o prende: `if (membershipStatus === 'none') return <MembershipRequired />`
   ([app/(app)/_layout.tsx:76](app/(app)/_layout.tsx#L76)) roda **antes** de qualquer rota ser montada. E
   `(auth)/_layout.tsx:16` redireciona quem está autenticado de volta — ele não consegue nem voltar
   ao login. Uma tela, um botão: "Sair".
4. O texto manda "peça ao administrador que envie um convite para o seu e-mail". O administrador
   **não existe** (a empresa foi apagada) e o convite **nunca enviou e-mail** — decisão registrada em
   [invite-member/index.ts:149-153](supabase/functions/invite-member/index.ts#L149).

**O resultado:** ele não consegue exercer nenhum direito sobre a própria conta. Não exclui, não
pede os dados, não entende o que houve.

**A boa notícia:** o backend já resolve. O caminho de quem não é dono em
[delete-account/index.ts:276-295](supabase/functions/delete-account/index.ts#L276) funciona para o órfão — o
`UPDATE` em `tenant_members` casa zero linhas (sem erro) e o `deleteUser` roda. **Falta só um
caminho de UI.**

**Decisões tomadas com o dono (15/09/2026):** registrar o motivo do desvínculo, avisar o
funcionário por e-mail no momento da exclusão, e purgar contas órfãs após 6 meses com aviso prévio.

---

## Decisões de arquitetura

**D1 — Uma RPC responde "por que estou sem empresa?".** Hoje três situações colapsam no mesmo
`'none'`: nunca convidado, inativado pelo dono, empresa excluída. A nova
`my_membership_status()` distingue as três numa chamada só, olhando, nesta ordem: vínculo ativo →
linha própria com `removed_at` (caso "inativado", que já existe no banco e só não é visível pela
RLS) → linha em `former_members` (caso "empresa excluída") → senão, "nunca".

**D2 — `former_members` guarda o mínimo: `user_id` + motivo + data. SEM o nome da empresa.**
Guardar "você trabalhava na Empresa X" depois de a Empresa X pedir a eliminação seria reter dado de
quem pediu para sumir. O funcionário precisa saber *o que* aconteceu, não *de quem*. FK para
`auth.users` com `on delete cascade` — diferente da doutrina da MIGRATION_21, que vale para tabelas
de **autoria**; esta é metadado *do próprio usuário* e deve morrer com ele.

**D3 — A tela bloqueada ganha ação, não só explicação.** `MembershipRequired` passa a oferecer
excluir a própria conta (reusando o caminho que já existe), falar com o suporte (mesmo padrão de
`AccessBlocked`, via `EXPO_PUBLIC_SUPPORT_CONTACT`) e ver o e-mail cadastrado — que é, literalmente,
o único dado pessoal que sobrou dele no sistema.

**D4 — A purga é a terceira fila do worker horário.** `process-deletion-requests` vira, na prática,
o worker de ciclo de vida de conta. O nome fica estreito demais para o que ele faz, mas renomear
exigiria mexer no cron e no secret — não compensa. Documentar no README.

**D5 — O aviso de purga não tem botão de "manter".** Um link de auto-serviço para estender o prazo
seria mais um endpoint público com token — superfície nova para um caso raro. O e-mail diz o que vai
acontecer, quando, e que ser adicionado a uma empresa (ou falar com o suporte) evita a exclusão. A
purga verifica o vínculo no momento de executar, então quem for adicionado é poupado sozinho.

---

## Fase 1 — Banco (`docs/banco-multi-cliente/MIGRATION_26_former_members.sql`)

Cabeçalho no padrão do repo (PROBLEMA / DECISÕES / O QUE MUDA + rodapé de VERIFICAÇÃO),
`begin; … commit;`, idempotente. Próximo número livre: **26**.

**Tabela `public.former_members`**
```
id            uuid pk
user_id       uuid not null unique references auth.users(id) on delete cascade
reason        text not null check (reason in ('tenant_deleted'))
occurred_at   timestamptz not null default now()
notified_at   timestamptz          -- aviso de encerramento enviado
warning_sent_at timestamptz        -- aviso dos 6 meses enviado
purge_after   timestamptz not null -- occurred_at + 6 meses
purged_at     timestamptz
created_at/updated_at
```
- `unique (user_id)` + upsert: quem for órfão duas vezes tem a data renovada, não duplicada.
- Índice `(purge_after)` para a varredura.
- **RLS**: `former_members_self_read` — `using (user_id = auth.uid())`. Sem policy de escrita: só
  RPC `security definer` e `service_role`. O dono do SaaS não precisa ver isso; não é fila de trabalho.

**`delete_tenant_cascade(uuid)`** — sexta versão. Antes do `delete from public.tenants`, registrar
os membros ativos que **não** são o solicitante (esse é apagado logo em seguida pelo worker):
```sql
insert into public.former_members (user_id, reason, purge_after)
select tm.user_id, 'tenant_deleted', now() + interval '6 months'
  from public.tenant_members tm
 where tm.tenant_id = p_tenant_id and tm.removed_at is null
on conflict (user_id) do update
   set occurred_at = now(), purge_after = now() + interval '6 months',
       warning_sent_at = null, updated_at = now();
```

**RPC `my_membership_status()`** (`security definer`, `grant execute to authenticated`) — devolve
`{ status, reason, occurredAt, email }` conforme D1. É a única fonte da tela; sem ela o app continua
adivinhando.

**RPC `admin_orphan_accounts_count()`** — opcional, para o dono ver no painel quantas contas órfãs
existem. Baixa prioridade; incluir só se sobrar espaço.

---

## Fase 2 — Worker e e-mails (`supabase/functions/process-deletion-requests/index.ts`)

**Terceira fila**, no modo cron, depois das duas que já existem:

1. **Aviso de encerramento** — linhas com `notified_at is null`: lê o e-mail em `auth.users` pelo
   `user_id` (service_role), manda o e-mail e carimba `notified_at`. Assunto e corpo próprios: o
   acesso à empresa terminou, **a conta pessoal continua ativa**, e o que ele pode fazer (esperar um
   convite novo, excluir a conta, falar com o suporte). Nada sobre exclusão de dados da empresa.
2. **Aviso de purga** — `purge_after - 15 dias <= now()`, `warning_sent_at is null`, e o usuário
   **ainda sem vínculo ativo**: informa a data e o que evita a exclusão.
3. **Purga** — `purge_after <= now()` e ainda sem vínculo ativo: `auth.admin.deleteUser(user_id)`.
   A linha de `former_members` cascateia junto.

Cada item isolado em `try/catch`, como as filas existentes: uma falha não derruba a rodada.

`run_due_account_deletions()` (na MIGRATION_26) passa a disparar também quando há trabalho nesta
terceira fila — hoje ela só chama a função se houver exclusão vencida ou exportação na fila.

---

## Fase 3 — App mobile

**`src/ui/MembershipRequired.tsx`** — reescrita. Consulta `my_membership_status()` e mostra:

| reason | título | corpo |
|---|---|---|
| `tenant_deleted` | Empresa encerrada | A empresa que você usava encerrou a conta no Sir Barbecue, então seu acesso terminou. **Sua conta continua sua** — se alguém te adicionar a outra empresa, é só entrar de novo. |
| `removed` | Acesso removido | O responsável pela empresa removeu seu acesso. Fale com ele para voltar a usar. |
| `never` | Conta sem empresa | Sua conta ainda não está vinculada a nenhuma empresa. Quem administra a empresa precisa te adicionar pelo app — **não é enviado e-mail de convite**, então avise a pessoa de que você já se cadastrou com este e-mail. |

Ações (além do "Sair" que já existe):
- **"Excluir minha conta"** → painel inline com a prova (senha, ou o próprio e-mail para conta
  Google), reusando o padrão de `perfil.tsx` e chamando o mesmo `requestAccountDeletion`. Sem
  formulário de agendamento, sem contato: para não-dono a exclusão é imediata.
- **"Falar com o suporte"** → mesmo padrão de [AccessBlocked.tsx:44-50](src/ui/AccessBlocked.tsx#L44).
- Mostrar o **e-mail cadastrado** na tela: é o único dado pessoal dele que resta, e exibi-lo
  satisfaz o direito de acesso sem precisar de exportação nenhuma.
- Corrigir o bloco `pending > 0`, que também assume um responsável existente.

**`app/(app)/mais/perfil.tsx` — defeito a corrigir (introduzido na entrega anterior).** A tela
**não tem nenhuma checagem de papel**: um funcionário vê as duas opções de prazo, é obrigado a
preencher nome e telefone, aperta "Solicitar exclusão (28/09/2026)" — e o servidor apaga **na
hora**, porque para não-dono o caminho é imediato. A tela promete uma coisa e o servidor faz outra.
Correção: com `role !== 'owner'`, mostrar um painel simples — aviso de que a conta será excluída
imediatamente, campo de prova, botão "Excluir minha conta" — sem opções de exportação, sem campos
de contato.

---

## Fase 4 — PWA (`c:\develop\WEB\sir-barbecue-web`)

Espelho das mesmas mudanças: `src/ui/MembershipRequired.tsx` (cuja copy é congelada por
`src/screens/screens.test.tsx:93-95` — o teste precisa acompanhar) e `src/screens/conta/Conta.tsx`
com a mesma correção de papel. Diferenças de sempre: `window.confirm` no lugar de `Alert.alert`,
`variant="danger"` já existe, e o botão inerte precisa deixar de ser `type="submit"`.

---

## Fase 5 — Textos legais e ajuda

- **Política de privacidade** (`sir-barbecue-admin/src/content/politicaDePrivacidade.ts`): a seção
  de retenção precisa dizer o que acontece com a conta de um MEMBRO quando a empresa é excluída — a
  conta pessoal dele sobrevive, e é encerrada após 6 meses sem vínculo, com aviso prévio. Hoje o
  texto só fala da conta de quem exclui.
- **Tópico de ajuda "O que acontece quando eu excluo minha conta"**: acrescentar que, para quem é
  gerente ou funcionário, a exclusão é imediata (sem prazo e sem cópia por e-mail) — hoje o tópico
  descreve só o fluxo do dono.

---

## Verificação

**Banco** (Postgres descartável, como nas MIGRATIONs 24 e 25):
1. Criar tenant + owner + 2 funcionários; rodar `delete_tenant_cascade` → 2 linhas em
   `former_members` com `reason='tenant_deleted'` e `purge_after` a 6 meses; o owner **não** entra.
2. `my_membership_status()` para cada perfil: funcionário órfão → `tenant_deleted`; membro inativado
   (`removed_at`) → `removed`; usuário novo → `never`; membro ativo → `member`.
3. Órfão que ganha vínculo novo → `my_membership_status()` volta a `member` e a purga o ignora.

**App (mobile e PWA):** entrar com uma conta órfã → a tela mostra "Empresa encerrada", o e-mail
cadastrado, e os três botões. Excluir a conta pela própria tela → some do `auth.users` e a linha de
`former_members` cascateia. Testar também o funcionário **com** vínculo excluindo a própria conta:
não deve ver formulário de agendamento nem campos de contato.

**Worker:** com uma linha recém-criada, rodar `admin_run_due_account_deletions_now()` → e-mail de
encerramento chega e `notified_at` é carimbado. Antecipar `purge_after` para testar o aviso de 15
dias e, depois, a purga — confirmando que um órfão que ganhou vínculo no meio do caminho **não** é
apagado.

---

## Riscos conhecidos

- **A purga apaga a conta de alguém que não pediu.** É o ponto mais delicado desta entrega. Mitigado
  por: dois e-mails (encerramento e aviso de 15 dias), 6 meses de janela, e a verificação de vínculo
  no instante da execução. Ainda assim, quem trocar de e-mail ou não ler nada perde a conta — e a
  política de privacidade precisa dizer isso com clareza antes de a purga entrar no ar.
- **O e-mail de encerramento é enviado depois de a empresa já ter sido apagada.** Se falhar, não há
  como reconstruir a lista de membros — ela morreu com o cascade. Por isso `former_members` é
  gravada **dentro** da mesma transação do `delete_tenant_cascade`, antes do `delete from tenants`:
  o envio pode ser retentado a partir dela.
- **`former_members` cria uma dependência nova de `auth.users`**, contra a doutrina da MIGRATION_21.
  É deliberado (D2) e vale registrar no cabeçalho da migração para não parecer descuido.
