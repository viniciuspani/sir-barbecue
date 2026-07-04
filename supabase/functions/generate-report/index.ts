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
type ProductSupplierRow = { product_client_id: string; purchase_price: number; is_preferred: boolean };
// Agregado por produto no período: quantidade (saída), receita e custo — base da margem.
type ProductStat = { id: string; qty: number; revenue: number; cost: number; hasCost: boolean };

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

    // Custo unitário p/ margem (RF-07): preço do fornecedor PREFERIDO; sem preferido, o menor preço
    // de compra cadastrado; sem cadastro, null (margem exibida como "—").
    const { data: psData } = await u
      .from('product_suppliers')
      .select('product_client_id, purchase_price, is_preferred');
    const supplierCosts = (psData ?? []) as unknown as ProductSupplierRow[];
    const costOf = (id: string): number | null => {
      const rows = supplierCosts.filter((c) => c.product_client_id === id);
      if (rows.length === 0) return null;
      const preferred = rows.find((c) => c.is_preferred);
      return Number(preferred ? preferred.purchase_price : Math.min(...rows.map((c) => c.purchase_price)));
    };

    let total = 0;
    const byPayment: Record<string, number> = {};
    const byProduct: Record<string, ProductStat> = {};
    for (const s of sales) {
      total += Number(s.total_amount);
      byPayment[s.payment_method] = (byPayment[s.payment_method] ?? 0) + Number(s.total_amount);
      for (const it of s.sale_items ?? []) {
        const id = it.product_client_id;
        const p = (byProduct[id] ??= { id, qty: 0, revenue: 0, cost: 0, hasCost: false });
        const qty = Number(it.quantity);
        p.qty += qty;
        p.revenue += qty * Number(it.unit_price);
        const c = costOf(id);
        if (c != null) {
          p.cost += qty * c;
          p.hasCost = true;
        }
      }
    }
    const topProducts = Object.values(byProduct).sort((a, b) => b.qty - a.qty);

    // Margem do negócio (consolidado): calculada sobre os itens COM custo cadastrado,
    // p/ que receita e custo fiquem na mesma base e a % não seja inflada.
    let costedRevenue = 0;
    let totalCost = 0;
    for (const p of topProducts) {
      if (!p.hasCost) continue;
      costedRevenue += p.revenue;
      totalCost += p.cost;
    }
    const profit = costedRevenue - totalCost;
    const marginPct = costedRevenue > 0 ? (profit / costedRevenue) * 100 : null;

    const html = renderHtml({
      type,
      start,
      end,
      total,
      count: sales.length,
      byPayment,
      topProducts,
      profit,
      marginPct,
      nameOf,
    });

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
  topProducts: ProductStat[];
  /** Lucro do negócio no período (receita − custo dos itens com custo cadastrado). */
  profit: number;
  /** Margem de lucro do negócio em %, ou null se nenhum produto tem custo cadastrado. */
  marginPct: number | null;
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

  // SVG bar chart — barras horizontais dimensionadas para o celular (~360px).
  // viewBox estreito (≈330 útil) => escala ~1:1 no WebView, fontes internas legíveis.
  // Layout por linha: rótulo em cima, barra embaixo, valor colocado abaixo/ao lado da barra.
  const BAR_W = 330; // largura da trilha (a barra ocupa a linha inteira)
  const BAR_ROW_H = 64; // mais respiro vertical entre itens
  const BAR_H = 26; // barras mais altas p/ toque/leitura
  const BAR_X = 0; // barras começam na borda esquerda
  const LBL_FS = 16; // fonte do rótulo do item
  const VAL_FS = 15; // fonte do valor

  const payBars = payEntries
    .map((e, i) => {
      const pct = payTotal > 0 ? e.value / payTotal : 0;
      const barW = Math.round(pct * BAR_W);
      const y = i * BAR_ROW_H;
      const labelY = y + LBL_FS + 2;
      const barY = y + LBL_FS + 10;
      const valueText = e.value > 0 ? brl(e.value) : '—';
      const pctText = payTotal > 0 ? ` (${Math.round(pct * 100)}%)` : '';
      // Valor: ao lado da barra se couber, senão sobre o fim da barra (fica sempre dentro do viewBox)
      const valInside = barW > BAR_W - 90;
      const valX = valInside ? Math.max(BAR_X + 8, barW - 8) : BAR_X + barW + 8;
      const valAnchor = valInside ? 'end' : 'start';
      const valFill = valInside && barW > 0 ? '#1A1A1A' : '#E8BA2A';
      return [
        // Rótulo (forma de pagamento)
        `<text x="${BAR_X}" y="${labelY}" fill="#DADADA" font-size="${LBL_FS}" font-weight="500" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${escapeHtml(e.label)}</text>`,
        // Trilha (fundo)
        `<rect x="${BAR_X}" y="${barY}" width="${BAR_W}" height="${BAR_H}" rx="6" fill="#333333"/>`,
        // Barra (dourado, proporcional)
        barW > 0
          ? `<rect x="${BAR_X}" y="${barY}" width="${barW}" height="${BAR_H}" rx="6" fill="#D4A017"/>`
          : '',
        // Valor (montante + %)
        `<text x="${valX}" y="${barY + BAR_H / 2 + VAL_FS / 3}" text-anchor="${valAnchor}" fill="${valFill}" font-size="${VAL_FS}" font-weight="700" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${escapeHtml(valueText)}${escapeHtml(pctText)}</text>`,
      ].join('');
    })
    .join('');

  const paySvgH = payEntries.length * BAR_ROW_H;
  const paySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_W} ${paySvgH}" width="100%" style="display:block;overflow:visible">${payBars}</svg>`;

  // ── Products chart ───────────────────────────────────────────────────────────
  const TOP_N = 8;
  const topSlice = r.topProducts.slice(0, TOP_N);
  const maxQty = topSlice.length > 0 ? topSlice[0].qty : 1;
  const LOW_OUTPUT_RATIO = 0.3; // qty <= 30% da saída do campeão => "baixa saída" (barra vermelha)

  // Trunca nomes longos p/ não estourar a linha (a margem ocupa a direita)
  const truncate = (s: string, max = 20) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);
  const marginOf = (p: ProductStat): number | null =>
    p.hasCost && p.revenue > 0 ? ((p.revenue - p.cost) / p.revenue) * 100 : null;
  const marginColor = (m: number | null): string => {
    if (m == null) return '#8A8A8A';
    return m < 0 ? '#E74C3C' : '#DADADA';
  };

  let prodSvgBlock: string;
  if (topSlice.length === 0) {
    prodSvgBlock = `<p style="color:#B0B0B0;font-size:15px;margin:8px 0 20px">Sem vendas no período.</p>`;
  } else {
    const prodBars = topSlice
      .map((p, i) => {
        const pct = maxQty > 0 ? p.qty / maxQty : 0;
        const barW = Math.round(pct * BAR_W);
        const y = i * BAR_ROW_H;
        const labelY = y + LBL_FS + 2;
        const barY = y + LBL_FS + 10;
        const name = escapeHtml(truncate(r.nameOf(p.id)));
        // Baixa saída => vermelho: sinaliza produto que não está gerando valor.
        const lowOutput = p.qty <= maxQty * LOW_OUTPUT_RATIO;
        const barColor = lowOutput ? '#E74C3C' : '#27AE60';
        // Margem do produto no canto direito da linha do nome (vermelha se prejuízo).
        const m = marginOf(p);
        const marginText = m == null ? 'margem —' : `margem ${Math.round(m)}%`;
        const marginFill = marginColor(m);
        // Quantidade: dentro da barra (fim) se couber, senão logo após a barra
        const qtyInside = barW > 44;
        const qtyX = qtyInside ? Math.max(BAR_X + 8, barW - 8) : BAR_X + barW + 8;
        const qtyAnchor = qtyInside ? 'end' : 'start';
        const qtyFill = qtyInside ? '#101010' : '#DADADA';
        return [
          `<text x="${BAR_X}" y="${labelY}" fill="#DADADA" font-size="${LBL_FS}" font-weight="500" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${name}</text>`,
          `<text x="${BAR_W}" y="${labelY}" text-anchor="end" fill="${marginFill}" font-size="${VAL_FS - 1}" font-weight="600" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${escapeHtml(marginText)}</text>`,
          `<rect x="${BAR_X}" y="${barY}" width="${BAR_W}" height="${BAR_H}" rx="6" fill="#333333"/>`,
          `<rect x="${BAR_X}" y="${barY}" width="${barW}" height="${BAR_H}" rx="6" fill="${barColor}"/>`,
          `<text x="${qtyX}" y="${barY + BAR_H / 2 + VAL_FS / 3}" text-anchor="${qtyAnchor}" fill="${qtyFill}" font-size="${VAL_FS}" font-weight="700" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${p.qty}</text>`,
        ].join('');
      })
      .join('');

    const prodSvgH = topSlice.length * BAR_ROW_H;
    const legend = `<p style="color:#B0B0B0;font-size:12px;margin:12px 2px 0;line-height:1.5">
      <span style="color:#E74C3C;font-weight:800">■</span> Baixa saída (≤ ${Math.round(LOW_OUTPUT_RATIO * 100)}% do campeão) — produto gerando pouco valor.
    </p>`;
    prodSvgBlock = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_W} ${prodSvgH}" width="100%" style="display:block;overflow:visible">${prodBars}</svg>${legend}`;
  }

  // ── Ticket médio + margem do negócio ─────────────────────────────────────────
  const avgTicket = r.count > 0 ? r.total / r.count : 0;
  const hasMargin = r.marginPct != null;
  const profitClass = r.profit < 0 ? 'loss' : 'green';
  const marginValue = r.marginPct == null ? '—' : `${Math.round(r.marginPct)}%`;
  const marginClass = r.marginPct != null && r.marginPct < 0 ? 'loss' : '';

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
    flex-direction:column;
    gap:12px;
    padding:16px 20px;
  }
  .kpi-row{
    display:flex;
    gap:12px;
  }
  .kpi-card{
    flex:1;
    min-width:0;
    background:#252525;
    border:1px solid #333333;
    border-radius:14px;
    padding:16px 16px;
    position:relative;
    overflow:hidden;
  }
  .kpi-card::before{
    content:'';
    position:absolute;
    top:0;left:0;right:0;
    height:4px;
    background:linear-gradient(90deg,#D4A017,#E8BA2A);
    border-radius:14px 14px 0 0;
  }
  .kpi-card.green::before{background:linear-gradient(90deg,#27AE60,#2ecc71)}
  .kpi-card.loss::before{background:linear-gradient(90deg,#E74C3C,#c0392b)}
  .kpi-label{
    font-size:13px;
    color:#B0B0B0;
    text-transform:uppercase;
    letter-spacing:0.8px;
    font-weight:600;
    margin-bottom:8px;
  }
  .kpi-value{
    font-size:26px;
    font-weight:800;
    color:#D4A017;
    line-height:1.15;
    word-break:break-word;
  }
  .kpi-card.green .kpi-value{color:#27AE60}
  .kpi-card.loss .kpi-value{color:#E74C3C}
  /* Faturamento: número mais importante do relatório — largura total e maior */
  .kpi-hero{padding:20px 18px}
  .kpi-hero .kpi-label{font-size:14px;margin-bottom:10px}
  .kpi-hero .kpi-value{font-size:40px;letter-spacing:-0.5px}

  /* Sections */
  .section{
    padding:0 20px;
    margin-top:20px;
  }
  .section-title{
    font-size:15px;
    font-weight:700;
    text-transform:uppercase;
    letter-spacing:0.8px;
    color:#D4A017;
    margin-bottom:14px;
    display:flex;
    align-items:center;
    gap:10px;
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
    padding:18px 16px 14px;
    overflow:visible;
  }

  /* Divider */
  .divider{height:1px;background:#333333;margin:20px 0}

  /* Footer */
  .footer{
    padding:20px 20px 0;
    text-align:center;
    color:#B0B0B0;
    font-size:13px;
    line-height:1.7;
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
  <div class="kpi-card kpi-hero">
    <div class="kpi-label">Faturamento</div>
    <div class="kpi-value">${escapeHtml(brl(r.total))}</div>
  </div>
  <div class="kpi-row">
    <div class="kpi-card green">
      <div class="kpi-label">Vendas</div>
      <div class="kpi-value">${r.count}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Ticket Médio</div>
      <div class="kpi-value">${escapeHtml(brl(avgTicket))}</div>
    </div>
  </div>
  <div class="kpi-row">
    <div class="kpi-card ${profitClass}">
      <div class="kpi-label">Lucro (mês)</div>
      <div class="kpi-value">${hasMargin ? escapeHtml(brl(r.profit)) : '—'}</div>
    </div>
    <div class="kpi-card ${marginClass}">
      <div class="kpi-label">Margem de lucro</div>
      <div class="kpi-value">${marginValue}</div>
    </div>
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
  ${hasMargin ? 'Margem sobre o preço do fornecedor preferido.<br>' : 'Cadastre o preço de compra dos produtos para ver a margem de lucro.<br>'}
  Gerado em <strong>${new Date().toLocaleString('pt-BR')}</strong><br>
  Sir Barbecue · PDV
</div>

</body>
</html>`;
}
