# Monitoramento do backend — endpoint `/health` + monitor externo

Como saber que o sistema caiu **antes** de o cliente descobrir no meio de uma venda.

---

## 1. O que é o `/health`

Uma URL pública que responde se o backend está de pé:

```
https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/health
```

Ela testa duas coisas:

| Camada | Como é testada |
|---|---|
| **Runtime das Edge Functions** | se a resposta chegou, ele está no ar (é a mesma infraestrutura que serve `generate-report`, `invite-member`, `send-push`) |
| **Banco de dados (Postgres)** | round-trip real: chama a RPC `public.saude_db()`, que toca uma tabela do schema e devolve a hora do banco |

> **Por que não dá para monitorar "o aplicativo":** o app é React Native — roda no aparelho do
> cliente, não tem URL. O que quebra para todo mundo ao mesmo tempo é o backend, e é isso que o
> `/health` cobre. (O app é offline-first: com o backend fora ele continua vendendo local; o que
> para é o sync, o login novo e os relatórios.)

### Respostas

**Tudo ok — HTTP 200:**
```json
{"status":"ok","service":"sir-barbecue","version":"0.1.0",
 "checks":{"edge":{"ok":true},"database":{"ok":true,"latency_ms":37}},
 "ts":"2026-08-15T12:00:00.000Z"}
```

**Banco fora ou lento demais (>5 s) — HTTP 503:**
```json
{"status":"down","service":"sir-barbecue","version":"0.1.0",
 "checks":{"edge":{"ok":true},"database":{"ok":false,"latency_ms":5001,"error":"db_unreachable"}},
 "ts":"..."}
```

**Sem resposta / timeout / 5xx do próprio Supabase** = o runtime também caiu (ou o projeto foi
pausado). O monitor externo pega esse caso pela ausência de resposta.

Códigos de erro possíveis em `database.error` (genéricos de propósito — a mensagem completa do
Postgres só vai para o log da função, para não vazar o schema num endpoint público):

| Código | Significa |
|---|---|
| `db_unreachable` | não conseguiu falar com o banco, ou passou de 5 s |
| `db_error` | o banco respondeu com erro (RPC ausente, permissão revogada, schema quebrado) |
| `db_unexpected` | respondeu, mas não no formato esperado — suspeitar de migração pela metade |
| `config_missing` | a função foi deployada sem `SUPABASE_URL`/`SUPABASE_ANON_KEY` no ambiente |

Detalhe completo do erro: **Supabase Dashboard → Edge Functions → `health` → Logs**.

---

## 2. Instalação (uma vez)

### 2.1 Aplicar a migração

Supabase Dashboard → **SQL Editor** → New query → colar
[`docs/banco-multi-cliente/MIGRATION_06_saude.sql`](../banco-multi-cliente/MIGRATION_06_saude.sql) → **Run**.

Conferir: `select public.saude_db();` deve devolver `{"ok": true, "db_time": "..."}`.

### 2.2 Publicar a Edge Function

Pela CLI:
```bash
supabase functions deploy health --no-verify-jwt
```

Ou pelo Dashboard: **Edge Functions → Create a new function**, nome `health`, colar
`supabase/functions/health/index.ts`, **Deploy** → depois em **Function Settings** desligar
**Verify JWT**.

> ⚠️ O `--no-verify-jwt` (ou o toggle **Verify JWT with legacy secret** desligado, no dashboard)
> é obrigatório. É o que permite ao monitor chamar a URL sem header de autenticação. Sem isso a
> resposta é `401` e o monitor vai alertar falha 24h por dia. Só as duas funções de saúde saem
> assim — e esta não expõe dado nenhum.

### 2.3 Testar antes de ligar o monitor

```bash
curl -i https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/health
```
Esperado: `HTTP/2 200` + o JSON com `"status":"ok"`, **sem** mandar nenhum header.

---

## 3. Monitor externo: HetrixTools (grátis, 1 em 1 minuto)

**Por que este:** o plano gratuito dá **15 monitores com checagem de 1 em 1 minuto**, 12
localidades no mundo e alerta por e-mail/Telegram/Slack/webhook. O UptimeRobot, mais famoso,
só faz 1 minuto no plano pago (no grátis são 5 minutos).

### Passo a passo

**1. Criar a conta**
Acesse <https://hetrixtools.com/>, clique em **Sign Up**, use um e-mail que você lê no celular
(é para lá que vai o alerta) e confirme o cadastro pelo link do e-mail.

**2. Criar a lista de contatos (para onde vai o alerta)**
No menu do topo, **Contact Lists → Add Contact List**.
- **Contact List Name:** `Alertas Sir Barbecue`
- Adicione o **e-mail** que receberá os avisos.
- Opcional e recomendado: adicionar também **Telegram** (o alerta chega na hora, e-mail às
  vezes demora ou cai em spam). Basta seguir o passo de conectar o bot que a própria tela mostra.
- **Save**.

**3. Criar o monitor**
Menu **Uptime Monitors → Add Uptime Monitor** → tipo **Website**.

| Campo (nome exato na tela) | O que colocar |
|---|---|
| **Monitor Name** | `Sir Barbecue — backend` |
| **Website Link** | `https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/health` |
| **Contact List** | `Alertas Sir Barbecue` (a que você criou no passo 2) |
| **Keyword** | `"status":"ok"` |
| **Locations** | marque de 3 a 5 localidades (ex.: São Paulo/Brasil + 2 EUA + 1 Europa) |

Sobre a **Keyword**: se esse texto não aparecer na resposta, o monitor considera o site fora —
mesmo que o servidor tenha respondido 200. É a rede de segurança contra o caso "o Supabase
responde, mas o banco está morto".

**4. Ajustar os "Advanced Settings"** (é onde fica o 1 minuto)

| Campo | Valor | Por quê |
|---|---|---|
| **Checkup Frequency** | **1 minute** | o que você pediu |
| **Timeout** | `10` segundos | a função corta o banco em 5 s; 10 dá folga de rede |
| **Number Of Failed Tries** | `2` | evita alerta por uma falha isolada de rede |
| **Number Of Failed Locations** | `2` | só alerta se 2 localidades concordarem que caiu — mata quase todo falso positivo |
| **Maximum Redirects** | `0` | o endpoint não redireciona; seguir redirect só esconderia problema |

**5.** Clicar em **Add Uptime Monitor**. Em até 1 minuto ele aparece na lista como **Online**.

**6. Testar o alarme de verdade** (não pule este passo — monitor que nunca disparou não é monitor)

No SQL Editor do Supabase:
```sql
revoke execute on function public.saude_db() from anon;   -- simula o banco fora
```
Em 1–2 minutos o monitor vira **Offline** e o e-mail/Telegram chega. Aí desfaça:
```sql
grant execute on function public.saude_db() to anon;      -- volta ao normal
```
O monitor volta para **Online** e manda o aviso de recuperação.

**7. Opcional — página de status pública**
Em **Status Pages → Add Status Page** você gera uma página (ex.: `sirbarbecue.hetrixtools.com`)
para mandar ao cliente quando ele perguntar "o sistema está fora?".

---

## 4. Integração com o painel admin

O painel (`c:\develop\WEB\sir-barbecue-admin`, publicado em
<https://sir-barbecue-admin.netlify.app/>) ganhou a aba **Saúde** — o mesmo dado do monitor,
sem precisar caçar e-mail. São duas camadas independentes:

### 4.1 "Está no ar agora" — card ao vivo

O painel faz um `fetch` direto no `/health` a cada 30 s (`SystemHealthCard`, presente no
Dashboard em versão compacta e no topo da aba Saúde). Não passa pelo supabase-js — funciona
até com a sessão do painel expirada.

**Configurar (dois lados, senão o navegador bloqueia):**

1. **Na função** — liberar a origem do painel:
   ```bash
   supabase secrets set ALLOWED_ORIGIN="https://sir-barbecue-admin.netlify.app,http://localhost:5173"
   supabase functions deploy health --no-verify-jwt   # redeploy: o CORS mudou
   ```
   A função aceita **lista separada por vírgula** e devolve só a origem que bateu (nunca `*`).
   Sem a origem na lista o card mostra "Sem resposta" mesmo com o backend no ar.
2. **No painel** — `.env` (e as *Environment variables* do Netlify):
   ```
   VITE_HEALTH_URL=https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/health
   ```
   O Vite grava as `VITE_*` **no build**, não lê em tempo de execução: depois de mexer na
   variável no Netlify é preciso **redeploy** do painel, senão nada muda.

> **Este card não é o alarme.** Se o Supabase cair por inteiro, o painel também não abre (o
> login dele depende do mesmo Supabase). Quem vigia 24h continua sendo o HetrixTools.

### 4.2 Histórico de quedas — webhook → banco → painel

```
HetrixTools detecta → POST saude-webhook → tabela health_events → RPCs admin → aba Saúde
                    ↘ e-mail + Telegram (continua igual)
```

**Passos:**

1. **Aplicar** [`MIGRATION_07_health_events.sql`](../banco-multi-cliente/MIGRATION_07_health_events.sql)
   no SQL Editor (tabela `health_events` + RPCs `admin_list_health_events` / `admin_health_summary`).
   É dado de plataforma: sem `tenant_id`, leitura só para `is_platform_admin()`.
2. **Publicar a função** com um segredo próprio (obrigatório — esta função *escreve*):
   ```bash
   supabase secrets set SAUDE_WEBHOOK_TOKEN="<segredo longo e aleatório>"
   supabase functions deploy health-webhook --no-verify-jwt
   ```
   Ela é *fail-closed*: sem o segredo configurado, recusa tudo (503) em vez de aceitar tudo.
3. **Ligar no HetrixTools:** menu **Contact Lists** → editar `Alertas Sir Barbecue` → adicionar
   um contato do tipo **Webhook** com a URL:
   ```
   https://ltwaotffsxbxkeydwoxm.supabase.co/functions/v1/health-webhook?token=<o mesmo segredo>
   ```
   Salvar. O mesmo evento passa a virar e-mail, Telegram **e** linha no banco — não é preciso
   mexer no monitor.
4. **Testar** repetindo o `revoke`/`grant` da seção 2.3: além do e-mail, tem que aparecer o par
   "Caiu / Voltou" na aba Saúde. Para conferir a tela antes da primeira queda real, o rodapé da
   MIGRATION_07 tem um `insert` que simula um incidente (e o `delete` para desfazer).

A aba mostra disponibilidade em 30 dias, número de quedas, tempo total fora e a lista com
duração de cada incidente e o motivo detectado (`timeout`, `keyword not found`, código HTTP).

## 5. Quando o alerta chegar (runbook)

0. **Abrir a aba Saúde do painel** (se ele carregar, o Supabase não caiu por inteiro): mostra o
   estado atual, a latência do banco e há quanto tempo está assim.
1. **Abrir a URL no navegador.** O que ela diz:
   - `"database":{"ok":false,...}` → Edge Functions de pé, **o banco é o problema**.
   - Não carrega / erro do Supabase → **o projeto inteiro está fora ou pausado**.
2. **Ver o status do provedor:** <https://status.supabase.com/>. Se for incidente deles, é esperar.
3. **Dashboard do Supabase:** projeto pausado (free tier pausa após 7 dias ocioso — com este
   monitor rodando isso não deve acontecer), banco em manutenção/upgrade, ou limite de conexões.
4. **Logs da função:** Edge Functions → `health` → Logs. Ali está a mensagem real do Postgres
   (`db_error` costuma ser permissão ou migração aplicada pela metade).
5. **Enquanto isso, o PDV continua vendendo offline.** O sync acumula e sobe sozinho quando
   voltar. O que **não** funciona: primeiro login de um aparelho novo, convite de membro,
   relatórios.

---

## 6. Custo

1 checagem por minuto = ~43.200 chamadas/mês, contra **500.000** invocações gratuitas de Edge
Function no plano free do Supabase (~9%). A consulta ao banco é de uma linha, com cache de 5 s
na função contra rajadas. Efeito colateral bom: projeto free do Supabase pausa depois de 7 dias
sem uso — o monitor mantém ele acordado.

---

## 7. Alternativa / redundância

Se quiser um segundo par de olhos (caso o próprio HetrixTools fique fora), o
<https://cron-job.org/> é gratuito, também roda de 1 em 1 minuto e manda e-mail em caso de
falha. Basta criar um cronjob apontando para a mesma URL, a cada 1 minuto, com "notificação em
caso de falha" ligada. Limitações dele: histórico curto (últimas 25 execuções) e ele considera
falha se a resposta passar de 1 KB ou 30 s — o `/health` responde bem abaixo dos dois.
