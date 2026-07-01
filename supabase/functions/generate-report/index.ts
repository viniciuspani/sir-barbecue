// Edge Function: generate-report (RF-21/24/25/26). SELF-CONTAINED (deployável pelo dashboard).
// Agrega as vendas da empresa no período, gera HTML, sobe no bucket `reports/<tenant_id>/`
// e registra a linha em `reports` (status ready). Chamada por usuário autenticado.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );
}

function userClient(req: Request): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
}

async function getCallerTenant(req: Request): Promise<{ userId: string; tenantId: string } | null> {
  const u = userClient(req);
  const { data } = await u.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const meta = user.app_metadata as { tenant_ids?: unknown } | undefined;
  const ids = meta?.tenant_ids;
  const claim = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
  if (claim) return { userId: user.id, tenantId: claim };
  const { data: row } = await u.from('tenant_members').select('tenant_id').limit(1).maybeSingle();
  const tid = (row as { tenant_id?: string } | null)?.tenant_id;
  return tid ? { userId: user.id, tenantId: tid } : null;
}

type SaleItem = { product_client_id: string; quantity: number; unit_price: number };
type SaleRow = {
  total_amount: number;
  payment_method: string;
  sale_date: string;
  sale_items: SaleItem[];
};
type ProductRow = { client_id: string; name: string };

const PAYMENT_LABELS: Record<string, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  credit_card: 'Crédito',
  debit_card: 'Débito',
};
const TYPE_LABELS: Record<string, string> = {
  daily_sales: 'Vendas do dia',
  monthly_sales: 'Vendas do mês',
  products_sold: 'Produtos vendidos',
  financial_summary: 'Resumo financeiro',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const caller = await getCallerTenant(req);
    if (!caller) return json({ error: 'Não autenticado.' }, 401);

    const body = (await req.json().catch(() => ({}))) as { type?: string; from?: string; to?: string };
    const type = body.type ?? 'monthly_sales';
    const now = new Date();
    const start = body.from ? new Date(body.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = body.to ? new Date(body.to) : now;

    const u = userClient(req); // RLS restringe à empresa do usuário
    const { data: salesData, error } = await u
      .from('sales')
      .select('total_amount, payment_method, sale_date, sale_items(product_client_id, quantity, unit_price)')
      .gte('sale_date', start.toISOString())
      .lte('sale_date', end.toISOString());
    if (error) throw error;
    const sales = (salesData ?? []) as unknown as SaleRow[];

    const { data: prodData } = await u.from('products').select('client_id, name');
    const products = (prodData ?? []) as unknown as ProductRow[];
    const nameOf = (id: string) => products.find((p) => p.client_id === id)?.name ?? '—';

    let total = 0;
    const byPayment: Record<string, number> = {};
    const byProduct: Record<string, number> = {};
    for (const s of sales) {
      total += Number(s.total_amount);
      byPayment[s.payment_method] = (byPayment[s.payment_method] ?? 0) + Number(s.total_amount);
      for (const it of s.sale_items ?? []) {
        byProduct[it.product_client_id] = (byProduct[it.product_client_id] ?? 0) + Number(it.quantity);
      }
    }
    const topProducts = Object.entries(byProduct).sort((a, b) => b[1] - a[1]);

    const html = renderHtml({ type, start, end, total, count: sales.length, byPayment, topProducts, nameOf });

    const admin = adminClient();
    const reportId = crypto.randomUUID();
    const path = `${caller.tenantId}/${reportId}.html`;
    // Uint8Array + contentType explícito: em Deno o campo `type` do Blob não é repassado
    // corretamente pelo SDK do Storage, fazendo o objeto ser salvo como application/octet-stream.
    // Passar o body como Uint8Array garante que apenas o `contentType` da opção seja aplicado.
    const upload = await admin.storage
      .from('reports')
      .upload(path, new TextEncoder().encode(html), {
        contentType: 'text/html; charset=utf-8',
        upsert: true,
      });
    if (upload.error) throw upload.error;

    const { error: insErr } = await u.from('reports').insert({
      tenant_id: caller.tenantId,
      client_id: reportId,
      type,
      status: 'ready',
      parameters: { from: start.toISOString(), to: end.toISOString() },
      html_url: path,
    });
    if (insErr) throw insErr;

    return json({ reportId, path, total, count: sales.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});

function brl(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(r: {
  type: string;
  start: Date;
  end: Date;
  total: number;
  count: number;
  byPayment: Record<string, number>;
  topProducts: [string, number][];
  nameOf: (id: string) => string;
}): string {
  const fmt = (d: Date) => d.toLocaleDateString('pt-BR');

  // ── Payment chart ────────────────────────────────────────────────────────────
  // Build entries for every known payment method (even if zero)
  const payEntries = Object.keys(PAYMENT_LABELS).map((k) => ({
    label: PAYMENT_LABELS[k],
    value: r.byPayment[k] ?? 0,
  }));
  const payTotal = payEntries.reduce((s, e) => s + e.value, 0);

  // SVG bar chart — horizontal bars, 280 wide × (entries * 44) tall
  const BAR_W = 280;
  const BAR_ROW_H = 44;
  const BAR_X = 0; // bars start at left edge; labels are placed to the right of bar area

  const payBars = payEntries
    .map((e, i) => {
      const pct = payTotal > 0 ? e.value / payTotal : 0;
      const barW = Math.round(pct * BAR_W);
      const y = i * BAR_ROW_H;
      const labelY = y + 14;
      const barY = y + 20;
      const valueText = e.value > 0 ? brl(e.value) : '—';
      const pctText = payTotal > 0 ? ` (${Math.round(pct * 100)}%)` : '';
      return [
        // Row label (method name)
        `<text x="${BAR_X}" y="${labelY}" fill="#B0B0B0" font-size="12" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${escapeHtml(e.label)}</text>`,
        // Track (dim background full-width)
        `<rect x="${BAR_X}" y="${barY}" width="${BAR_W}" height="14" rx="4" fill="#333333"/>`,
        // Fill bar (gold, proportional to share)
        barW > 0
          ? `<rect x="${BAR_X}" y="${barY}" width="${barW}" height="14" rx="4" fill="#D4A017"/>`
          : '',
        // Value label (amount + %)
        `<text x="${barW > 6 ? BAR_X + barW + 6 : BAR_X + 6}" y="${barY + 11}" fill="#E8BA2A" font-size="11" font-weight="600" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${escapeHtml(valueText)}${escapeHtml(pctText)}</text>`,
      ].join('');
    })
    .join('');

  const paySvgH = payEntries.length * BAR_ROW_H;
  const paySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_W + 160} ${paySvgH}" width="100%" style="display:block;overflow:visible">${payBars}</svg>`;

  // ── Products chart ───────────────────────────────────────────────────────────
  const TOP_N = 8;
  const topSlice = r.topProducts.slice(0, TOP_N);
  const maxQty = topSlice.length > 0 ? topSlice[0][1] : 1;

  let prodSvgBlock: string;
  if (topSlice.length === 0) {
    prodSvgBlock = `<p style="color:#B0B0B0;font-size:14px;margin:8px 0 20px">Sem vendas no período.</p>`;
  } else {
    const prodBars = topSlice
      .map(([id, qty], i) => {
        const pct = maxQty > 0 ? qty / maxQty : 0;
        const barW = Math.round(pct * BAR_W);
        const y = i * BAR_ROW_H;
        const labelY = y + 14;
        const barY = y + 20;
        const name = escapeHtml(r.nameOf(id));
        return [
          `<text x="${BAR_X}" y="${labelY}" fill="#B0B0B0" font-size="12" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${name}</text>`,
          `<rect x="${BAR_X}" y="${barY}" width="${BAR_W}" height="14" rx="4" fill="#333333"/>`,
          `<rect x="${BAR_X}" y="${barY}" width="${barW}" height="14" rx="4" fill="#27AE60"/>`,
          `<text x="${barW > 6 ? BAR_X + barW + 6 : BAR_X + 6}" y="${barY + 11}" fill="#B0B0B0" font-size="11" font-weight="600" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${qty}</text>`,
        ].join('');
      })
      .join('');

    const prodSvgH = topSlice.length * BAR_ROW_H;
    prodSvgBlock = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_W + 80} ${prodSvgH}" width="100%" style="display:block;overflow:visible">${prodBars}</svg>`;
  }

  // ── Ticket médio ─────────────────────────────────────────────────────────────
  const avgTicket = r.count > 0 ? r.total / r.count : 0;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório — ${escapeHtml(TYPE_LABELS[r.type] ?? r.type)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    background:#1A1A1A;
    color:#FFFFFF;
    min-height:100vh;
    padding:0 0 32px;
    -webkit-font-smoothing:antialiased;
  }

  /* Header */
  .header{
    background:linear-gradient(135deg,#252525 0%,#1A1A1A 100%);
    border-bottom:2px solid #D4A017;
    padding:20px 20px 16px;
    position:relative;
  }
  .header-brand{
    display:flex;
    align-items:center;
    gap:10px;
    margin-bottom:8px;
  }
  .brand-flame{
    font-size:28px;
    line-height:1;
  }
  .brand-name{
    font-size:20px;
    font-weight:800;
    letter-spacing:0.5px;
    color:#D4A017;
    text-transform:uppercase;
  }
  .report-type{
    font-size:13px;
    color:#B0B0B0;
    font-weight:500;
    text-transform:uppercase;
    letter-spacing:0.8px;
    margin-bottom:4px;
  }
  .report-period{
    font-size:16px;
    color:#FFFFFF;
    font-weight:600;
  }

  /* KPI cards */
  .kpi-grid{
    display:flex;
    gap:12px;
    padding:16px 20px;
    flex-wrap:wrap;
  }
  .kpi-card{
    flex:1;
    min-width:120px;
    background:#252525;
    border:1px solid #333333;
    border-radius:12px;
    padding:16px 14px;
    position:relative;
    overflow:hidden;
  }
  .kpi-card::before{
    content:'';
    position:absolute;
    top:0;left:0;right:0;
    height:3px;
    background:linear-gradient(90deg,#D4A017,#E8BA2A);
    border-radius:12px 12px 0 0;
  }
  .kpi-card.green::before{background:linear-gradient(90deg,#27AE60,#2ecc71)}
  .kpi-label{
    font-size:11px;
    color:#B0B0B0;
    text-transform:uppercase;
    letter-spacing:0.8px;
    font-weight:600;
    margin-bottom:8px;
  }
  .kpi-value{
    font-size:22px;
    font-weight:800;
    color:#D4A017;
    line-height:1.1;
    word-break:break-all;
  }
  .kpi-card.green .kpi-value{color:#27AE60}

  /* Sections */
  .section{
    padding:0 20px;
    margin-top:20px;
  }
  .section-title{
    font-size:13px;
    font-weight:700;
    text-transform:uppercase;
    letter-spacing:0.8px;
    color:#B0B0B0;
    margin-bottom:14px;
    display:flex;
    align-items:center;
    gap:8px;
  }
  .section-title::after{
    content:'';
    flex:1;
    height:1px;
    background:#333333;
  }

  /* Chart wrapper */
  .chart-wrap{
    background:#252525;
    border:1px solid #333333;
    border-radius:12px;
    padding:16px 14px 10px;
    overflow:hidden;
  }

  /* Divider */
  .divider{height:1px;background:#333333;margin:20px 0}

  /* Footer */
  .footer{
    padding:16px 20px 0;
    text-align:center;
    color:#B0B0B0;
    font-size:12px;
    line-height:1.6;
  }
  .footer strong{color:#D4A017}
</style>
</head>
<body>

<!-- ═══ HEADER ═══ -->
<div class="header">
  <div class="header-brand">
    <span class="brand-flame">🔥</span>
    <span class="brand-name">Sir Barbecue</span>
  </div>
  <div class="report-type">${escapeHtml(TYPE_LABELS[r.type] ?? r.type)}</div>
  <div class="report-period">${fmt(r.start)} — ${fmt(r.end)}</div>
</div>

<!-- ═══ KPI CARDS ═══ -->
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-label">Faturamento</div>
    <div class="kpi-value">${escapeHtml(brl(r.total))}</div>
  </div>
  <div class="kpi-card green">
    <div class="kpi-label">Vendas</div>
    <div class="kpi-value">${r.count}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Ticket Médio</div>
    <div class="kpi-value">${escapeHtml(brl(avgTicket))}</div>
  </div>
</div>

<!-- ═══ PAGAMENTOS ═══ -->
<div class="section">
  <div class="section-title">Formas de pagamento</div>
  <div class="chart-wrap">
    ${paySvg}
  </div>
</div>

<!-- ═══ PRODUTOS ═══ -->
<div class="section">
  <div class="section-title">Produtos mais vendidos</div>
  <div class="chart-wrap">
    ${prodSvgBlock}
  </div>
</div>

<!-- ═══ FOOTER ═══ -->
<div class="footer">
  Gerado em <strong>${new Date().toLocaleString('pt-BR')}</strong><br>
  Sir Barbecue · PDV
</div>

</body>
</html>`;
}
