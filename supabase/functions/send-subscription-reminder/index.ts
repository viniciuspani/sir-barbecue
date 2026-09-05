// Edge Function: send-subscription-reminder. SELF-CONTAINED (deployável pelo dashboard).
//
// Recebe da rotina send_subscription_due_reminders() (pg_net, disparada por pg_cron —
// ver docs/assinatura-app/MIGRATION_03_activation_and_reminders.sql) um aviso de
// vencimento próximo e envia um e-mail simples e cordial ao dono da empresa via Resend.
//
// DEPLOY (sem JWT — quem chama é o Postgres via pg_net, não um usuário logado):
//   supabase secrets set SUBSCRIPTION_REMINDER_TOKEN="<mesmo token do vault.create_secret>"
//   supabase secrets set RESEND_API_KEY="re_xxx..."
//   supabase secrets set EMAIL_FROM="Sir Barbecue <assinatura@seu-dominio>"
//   supabase functions deploy send-subscription-reminder --no-verify-jwt
//
// SEGURANÇA: mesmo padrão do health-webhook — fail-closed se o token não estiver
// configurado, e o token esperado vem via querystring (é o que dá pra passar numa URL
// chamada de dentro do Postgres).
const REMINDER_TOKEN = Deno.env.get('SUBSCRIPTION_REMINDER_TOKEN') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? '';

type ReminderPayload = {
  email?: string;
  tenantName?: string;
  dueDate?: string;
};

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function formatDueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(d);
}

// O nome da empresa é editável pelo dono (tela Minha Empresa) e chega aqui via
// send_subscription_due_reminders() -> net.http_post. Sem escape, ele era
// interpolado cru no HTML do e-mail: conteúdo arbitrário saindo sob o remetente
// e o domínio verificados do Sir Barbecue. Quem injeta é quem recebe (o
// destinatário é o próprio owner), então o risco é de reputação do domínio e de
// phishing reencaminhado — não de atingir outra empresa. Ver A05-01 na auditoria.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml(rawTenantName: string, dueDateFormatted: string): string {
  // O corte em 120 evita que um nome absurdamente longo desmonte o e-mail.
  const tenantName = escapeHtml(rawTenantName).slice(0, 120);
  return `
    <p>Olá, ${tenantName}!</p>
    <p>Passando para avisar que a assinatura do Sir Barbecue da sua empresa vence em
    <strong>${dueDateFormatted}</strong>.</p>
    <p>Para continuar usando o app sem interrupções, entre em contato com a gente para
    regularizar o pagamento até essa data.</p>
    <p>Qualquer dúvida, estamos à disposição.</p>
    <p>Equipe Sir Barbecue</p>
  `.trim();
}

Deno.serve(async (req: Request) => {
  // Fail-closed: sem segredo configurado, ninguém dispara e-mail.
  if (!REMINDER_TOKEN) {
    console.error('[send-subscription-reminder] SUBSCRIPTION_REMINDER_TOKEN não configurada — recusando tudo.');
    return textResponse('not configured', 503);
  }

  const token = new URL(req.url).searchParams.get('token') ?? '';
  // 404 para não confirmar a existência do endpoint a quem varre.
  if (token !== REMINDER_TOKEN) return textResponse('Not Found', 404);

  if (req.method !== 'POST') return textResponse('method not allowed', 405);

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.error('[send-subscription-reminder] RESEND_API_KEY/EMAIL_FROM não configurados.');
    return textResponse('email provider not configured', 503);
  }

  try {
    const payload = (await req.json().catch(() => ({}))) as ReminderPayload;
    const { email, tenantName, dueDate } = payload;
    if (!email || !tenantName || !dueDate) {
      return textResponse('missing email/tenantName/dueDate', 400);
    }

    const dueDateFormatted = formatDueDate(dueDate);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [email],
        subject: 'Sua assinatura Sir Barbecue vence em breve',
        html: buildEmailHtml(tenantName, dueDateFormatted),
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('[send-subscription-reminder] falha ao enviar via Resend:', res.status, detail);
      return textResponse('send failed', 502);
    }

    return textResponse('ok', 200);
  } catch (e) {
    console.error('[send-subscription-reminder] erro inesperado:', String((e as Error)?.message ?? e));
    return textResponse('bad request', 400);
  }
});
