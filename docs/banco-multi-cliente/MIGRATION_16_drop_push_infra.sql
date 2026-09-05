-- =====================================================================
-- MIGRATION 16 — Remoção da infra de push (etapa 2 da desativação)
-- Reverte MIGRATION_02_push_tokens.sql. Idempotente.
--
-- MOTIVAÇÃO:
--   Decisão de 20/08/2026, reafirmada em 02/09/2026: a notificação de estoque
--   baixo pelo sistema de notificação do celular não se justifica neste produto.
--   O app é um PDV — o operador fica com ele ABERTO durante todo o expediente
--   para vender, e o alerta de estoque já aparece de forma clara e proativa na
--   Home (seção "Alertas de estoque", app/(app)/index.tsx) a cada abertura e a
--   cada refresh. Push só agrega valor quando avisa quem NÃO está olhando o app.
--   Aqui ele era redundante e carregava infra própria: tabela com RLS, trigger
--   com egress via pg_net a cada baixa de estoque, Edge Function com service_role
--   e credenciais FCM no EAS — tudo para entregar de novo o que a tela já dá.
--
--   A etapa 1 (remover o ponto de entrada no app: tela de notificações, registro
--   de token no boot e src/services/push.ts) foi feita em 20/08/2026, commit
--   d0f5b57. Esta migração é a etapa 2: limpar o servidor.
--
-- O QUE SAI:
--   • trigger trg_notify_low_stock em stock_items
--   • função notify_low_stock()
--   • tabela push_tokens (leva junto a policy tenant_all e os índices)
--
-- O QUE FICA, DE PROPÓSITO:
--   • A extensão pg_net. Ela NÃO é exclusiva do push: o lembrete de vencimento
--     de assinatura (send_subscription_due_reminders, em
--     docs/assinatura-app/SUPABASE_SCHEMA_LICENSING.sql) chama net.http_post.
--     Dropar a extensão quebraria a cobrança.
--   • A coluna stock_items.alert_threshold e todo o alerta de estoque — o que
--     sai é só o CANAL de push; o alerta na Home continua sendo a entrega.
--
-- APPS ANTIGOS EM CAMPO (verificado, sem impacto):
--   Um APK anterior ao commit d0f5b57 ainda tenta gravar o token no boot. Com a
--   tabela removida, o upsert falha e a função devolve `{ token, error }` — o
--   chamador em app/_layout.tsx era `void registerAndSavePushToken(...)`, que
--   descarta o retorno, e a função nunca lança. Ou seja: falha em silêncio, sem
--   crash e sem mensagem para o usuário. Não é preciso distribuir APK novo por
--   causa desta migração.
--
-- ORDEM: rode isto DEPOIS de remover a Edge Function send-push
--   (supabase functions delete send-push), que lê esta tabela com service_role.
--   Invertendo a ordem nada quebra de verdade — ninguém chama essa função —, mas
--   ela passaria a responder erro em vez de deixar de existir.
--
-- DADOS PERDIDOS: os tokens de push dos aparelhos. Sem valor com o recurso
--   desligado, e reconstruíveis em um boot caso a decisão um dia se inverta.
-- =====================================================================

-- 1) Trigger e função do disparo automático -----------------------------
drop trigger if exists trg_notify_low_stock on public.stock_items;
drop function if exists public.notify_low_stock();

-- 2) Tabela (a policy tenant_all e os índices caem junto) ----------------
-- Sem CASCADE de propósito: nada referencia push_tokens. Se o Postgres
-- reclamar de dependência, PARE e investigue — apareceu algo não previsto aqui.
drop table if exists public.push_tokens;

-- =====================================================================
-- VERIFICAÇÃO — as três devem voltar ZERO linhas
-- =====================================================================
-- select tablename, policyname from pg_policies
--  where schemaname = 'public' and tablename = 'push_tokens';
--
-- select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'push_tokens';
--
-- select tgname from pg_trigger
--  where tgrelid = 'public.stock_items'::regclass
--    and not tgisinternal and tgname = 'trg_notify_low_stock';

-- E esta deve continuar voltando UMA linha (pg_net preservado):
-- select extname from pg_extension where extname = 'pg_net';

-- =====================================================================
-- ATENÇÃO — MIGRATION_02_push_tokens.sql não deve mais ser executada.
-- Ela é idempotente e recriaria tabela, policy e trigger. O arquivo foi mantido
-- no repositório como registro histórico, com aviso no cabeçalho.
-- =====================================================================
