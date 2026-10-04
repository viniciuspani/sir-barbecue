// Edge Function: generate-report (RF-21/24/25/26). SELF-CONTAINED (deployável pelo dashboard).
// Agrega as vendas da empresa no período, gera HTML, sobe no bucket `reports/<tenant_id>/`
// e registra a linha em `reports` (status ready). Chamada por usuário autenticado.
// Versão EXATA (não `@2`): sem lockfile, `@2` resolveria para a última 2.x no
// momento de cada deploy — e este código roda com a SERVICE_ROLE_KEY no ambiente.
// Ver A03-01 na auditoria (docs/auditoria-seguranca-web).
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';

// CORS restrito. Desde o app WEB (PWA), estas funções passaram a ser chamadas de
// dentro do NAVEGADOR — e o app roda em mais de uma origem ao mesmo tempo:
// produção, o localhost do desenvolvimento e o IP da máquina no teste em celular.
// Por isso ALLOWED_ORIGIN aceita uma LISTA separada por vírgula, e ecoamos de volta
// apenas a origem que bateu (nunca "*"):
//   supabase secrets set ALLOWED_ORIGIN="https://app.exemplo,http://localhost:5173"
// O app mobile chama via functions.invoke, sem preflight de browser: segue
// funcionando mesmo com a variável vazia.
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, '')) // tolera barra final ao colar a URL
  .filter(Boolean);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = (req.headers.get('Origin') ?? '').replace(/\/+$/, '');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    // Sem isto, um cache intermediário pode servir a resposta de uma origem para outra.
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// Devolve o `json` já preso à origem DESTA requisição. O handler o usa como antes.
function jsonFor(req: Request) {
  const cors = corsHeadersFor(req);
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
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

// Resolve o tenant do chamador. Se o corpo trouxer tenant_id, VALIDA que o usuário
// pertence a ele (via user_tenant_ids); senão cai para o claim/primeira membership.
async function getCallerTenant(
  req: Request,
  requestedTenantId: string | null,
): Promise<{ userId: string; tenantId: string } | null> {
  const u = userClient(req);
  const { data } = await u.auth.getUser();
  const user = data.user;
  if (!user) return null;

  if (requestedTenantId) {
    const { data: allowed } = await u.rpc('user_tenant_ids');
    const list: string[] = Array.isArray(allowed)
      ? allowed.map((r) => (typeof r === 'string' ? r : (r as { user_tenant_ids?: string }).user_tenant_ids ?? '')).filter(Boolean)
      : [];
    if (!list.includes(requestedTenantId)) return null; // não é membro do tenant pedido
    return { userId: user.id, tenantId: requestedTenantId };
  }

  const meta = user.app_metadata as { tenant_ids?: unknown } | undefined;
  const ids = meta?.tenant_ids;
  const claim = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
  if (claim) return { userId: user.id, tenantId: claim };
  const { data: row } = await u.from('tenant_members').select('tenant_id').limit(1).maybeSingle();
  const tid = (row as { tenant_id?: string } | null)?.tenant_id;
  return tid ? { userId: user.id, tenantId: tid } : null;
}

type SaleItem = { product_client_id: string; quantity: number; unit_price: number };
type SalePaymentRow = { method: string; amount: number };
type SaleRow = {
  total_amount: number;
  payment_method: string;
  sale_date: string;
  sale_items: SaleItem[];
  // Detalhe por forma (MIGRATION_28) — sempre populado em vendas novas, mesmo
  // com 1 forma só. Vendas de ANTES da migração vêm com [] (nunca tiveram
  // linha aqui) e caem no fallback via `payment_method` abaixo.
  sale_payments: SalePaymentRow[];
};
type ProductRow = { client_id: string; name: string };
type ProductSupplierRow = {
  product_client_id: string;
  purchase_price: number;
  is_preferred: boolean;
  is_active: boolean;
};
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
  period_sales: 'Vendas do período',
  products_sold: 'Produtos vendidos',
  financial_summary: 'Resumo financeiro',
};

// Formata sempre no fuso do negócio (Brasil), nunca no fuso do runtime da Edge
// Function (Deno Deploy roda em UTC). Perto da meia-noite local, `to.toISOString()`
// enviado pelo app já cai no dia seguinte em UTC — sem fixar o timeZone aqui, o
// relatório mostrava a data final um dia à frente do que realmente é "hoje" no Brasil.
const TZ = 'America/Sao_Paulo';

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const json = jsonFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      type?: string;
      from?: string;
      to?: string;
      tenant_id?: string;
    };

    const caller = await getCallerTenant(req, body.tenant_id ?? null);
    if (!caller) return json({ error: 'Não autenticado ou sem acesso à empresa.' }, 401);

    const u = userClient(req); // RLS restringe à empresa do usuário

    // Relatório é dado financeiro (receita, custo de fornecedor, margem): só
    // owner|manager. Antes desta checagem, a autorização acontecia por efeito
    // colateral — a função agregava tudo e subia o HTML no Storage com a
    // service_role, e só o INSERT em `reports` no fim é que batia na policy.
    // Um funcionário conseguia fazer o servidor trabalhar e deixar arquivo
    // órfão no bucket a cada chamada. Ver A01-02 na auditoria.
    const { data: me } = await u
      .from('tenant_members')
      .select('role')
      .eq('tenant_id', caller.tenantId)
      .eq('user_id', caller.userId)
      .maybeSingle();
    const role = (me as { role?: string } | null)?.role ?? '';
    if (role !== 'owner' && role !== 'manager') {
      return json({ error: 'Apenas dono ou gerente podem gerar relatórios.' }, 403);
    }

    const type = body.type ?? 'monthly_sales';
    const now = new Date();
    const start = body.from ? new Date(body.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = body.to ? new Date(body.to) : now;

    // Validação do intervalo (evita DoS por datas inválidas ou janela gigante).
    const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // 1 ano
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return json({ error: 'Datas inválidas.' }, 400);
    }
    if (start.getTime() > end.getTime()) {
      return json({ error: 'A data inicial deve ser anterior à final.' }, 400);
    }
    if (end.getTime() - start.getTime() > MAX_RANGE_MS) {
      return json({ error: 'Intervalo máximo do relatório é de 1 ano.' }, 400);
    }

    const { data: salesData, error } = await u
      .from('sales')
      .select(
        'total_amount, payment_method, sale_date, sale_items(product_client_id, quantity, unit_price), sale_payments(method, amount)',
      )
      .gte('sale_date', start.toISOString())
      .lte('sale_date', end.toISOString());
    if (error) throw error;
    const sales = (salesData ?? []) as unknown as SaleRow[];

    const { data: prodData } = await u.from('products').select('client_id, name');
    const products = (prodData ?? []) as unknown as ProductRow[];
    const nameOf = (id: string) => products.find((p) => p.client_id === id)?.name ?? '—';

    // Custo unitário p/ margem (RF-07): preço do fornecedor PREFERIDO; sem preferido, o menor preço
    // de compra cadastrado; sem cadastro, null (margem exibida como "—"). Considera só vínculos
    // ATIVOS — fornecedor inativado (troca de fornecedor) não entra no custo.
    const { data: psData } = await u
      .from('product_suppliers')
      .select('product_client_id, purchase_price, is_preferred, is_active');
    const supplierCosts = (psData ?? []) as unknown as ProductSupplierRow[];
    const costOf = (id: string): number | null => {
      const rows = supplierCosts.filter((c) => c.product_client_id === id && c.is_active);
      if (rows.length === 0) return null;
      const preferred = rows.find((c) => c.is_preferred);
      return Number(preferred ? preferred.purchase_price : Math.min(...rows.map((c) => c.purchase_price)));
    };

    let total = 0;
    const byPayment: Record<string, number> = {};
    const byProduct: Record<string, ProductStat> = {};
    for (const s of sales) {
      total += Number(s.total_amount);
      // Fonte da verdade é sale_payments (guarda cada forma de verdade, mesmo
      // dentro de uma venda dividida); payment_method só entra como fallback
      // para venda antiga, de antes de a tabela existir.
      if (s.sale_payments?.length) {
        for (const pmt of s.sale_payments) {
          byPayment[pmt.method] = (byPayment[pmt.method] ?? 0) + Number(pmt.amount);
        }
      } else {
        byPayment[s.payment_method] = (byPayment[s.payment_method] ?? 0) + Number(s.total_amount);
      }
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

    // ORDEM: grava a linha em `reports` ANTES de subir o arquivo. O INSERT passa
    // pelo cliente do usuário e portanto pela policy reports_access — é a última
    // barreira de autorização. Subindo antes (como era), uma recusa de RLS já
    // teria deixado um HTML com dados financeiros no bucket, sem dono e sem
    // rotina de limpeza. Ver A01-02 na auditoria.
    const { error: insErr } = await u.from('reports').insert({
      tenant_id: caller.tenantId,
      client_id: reportId,
      type,
      status: 'ready',
      parameters: { from: start.toISOString(), to: end.toISOString() },
      html_url: path,
    });
    if (insErr) throw insErr;

    // Uint8Array + contentType explícito: em Deno o campo `type` do Blob não é repassado
    // corretamente pelo SDK do Storage, fazendo o objeto ser salvo como application/octet-stream.
    // Passar o body como Uint8Array garante que apenas o `contentType` da opção seja aplicado.
    const upload = await admin.storage
      .from('reports')
      .upload(path, new TextEncoder().encode(html), {
        contentType: 'text/html; charset=utf-8',
        upsert: true,
      });
    if (upload.error) {
      // Sem o arquivo, a linha aponta para o vazio: desfaz para o usuário não
      // ver um relatório que abre em branco.
      await u.from('reports').delete().eq('client_id', reportId);
      throw upload.error;
    }

    return json({ reportId, path, total, count: sales.length });
  } catch (e) {
    // Não devolver a mensagem crua: os erros que passam por aqui vêm do
    // PostgREST/GoTrue e carregam nome de tabela, coluna, constraint e policy —
    // o mapa interno do banco, exibido num toast para qualquer usuário. O
    // detalhe fica no log da função, e o usuário leva um código para citar no
    // suporte. Ver A10-01 na auditoria.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[generate-report ${ref}]`, e);
    return json({ error: 'Não foi possível gerar o relatório.', ref }, 400);
  }
});

function brl(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// `toLocaleString('pt-BR', {style:'currency'})` separa "R$" do valor com um
// espaço NÃO-quebrável (U+00A0) — ótimo para não deixar "R$" sozinho numa
// ponta de linha em texto corrido, mas ruim nos KPIs grandes: numa tela
// estreita, sem um ponto de quebra válido ali, o navegador cai no fallback de
// quebrar o texto em qualquer lugar (CSS overflow-wrap:anywhere) e parte o
// número ao meio (ex.: "R$ 7.790,\n00"). Nos KPIs o valor troca o NBSP por um
// espaço comum: se precisar quebrar linha, quebra ali — "R$" numa linha,
// o número na outra — nunca no meio de um dígito.
function brlBreakable(n: number): string {
  return brl(n).replace(/ /g, ' ');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;');
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
  const fmt = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: TZ });

  // ── Payment chart ────────────────────────────────────────────────────────────
  // Build entries for every known payment method (even if zero)
  const payEntries = Object.keys(PAYMENT_LABELS).map((k) => ({
    label: PAYMENT_LABELS[k],
    value: r.byPayment[k] ?? 0,
  }));
  const payTotal = payEntries.reduce((s, e) => s + e.value, 0);

  // Barras em HTML/CSS puro (nada de SVG com viewBox esticado). Antes, cada barra
  // era um <svg viewBox="0 0 330 …" width="100%"> com <text> embutido: no celular
  // (~360px) a escala do viewBox era quase 1:1 e ficava legível, mas no PWA/desktop
  // (iframe de 1500-2500px) o "width:100%" esticava o SISTEMA DE COORDENADAS do SVG
  // — inclusive as fontes internas — virando texto gigante e desproporcional. Uma
  // <div> com largura em % não sofre disso: só a barra escala, o texto (fora do
  // elemento escalável) continua em `font-size` de verdade. Ver seção "Sections"
  // no <style> para o container central que também limita a largura no desktop.
  const barRow = (opts: {
    headLeft: string; // já escapado
    headRight?: string; // já escapado; ex.: margem do produto
    headRightColor?: string;
    pct: number; // 0–100
    color: string;
    valueText: string; // já escapado; renderizado dentro OU fora da barra
    insideThreshold: number; // % mínimo pra caber o texto dentro da barra
  }): string => {
    const pct = Math.max(0, Math.min(100, opts.pct));
    const inside = pct >= opts.insideThreshold;
    const valueSpan = `<span class="bar-value">${opts.valueText}</span>`;
    return `
      <div class="bar-row">
        <div class="bar-row-head">
          <span class="bar-name" title="${opts.headLeft}">${opts.headLeft}</span>
          ${opts.headRight ? `<span class="bar-margin" style="color:${opts.headRightColor ?? '#8A8A8A'}">${opts.headRight}</span>` : ''}
        </div>
        <div class="bar-line">
          <div class="bar-track">
            ${
              pct > 0
                ? `<div class="bar-fill" style="width:${pct.toFixed(2)}%;background:${opts.color}">${inside ? valueSpan : ''}</div>`
                : ''
            }
          </div>
          ${inside ? '' : valueSpan}
        </div>
      </div>`;
  };

  const payRows = payEntries
    .map((e) => {
      const pct = payTotal > 0 ? (e.value / payTotal) * 100 : 0;
      const valueText =
        e.value > 0 ? `${escapeHtml(brl(e.value))} (${Math.round(pct)}%)` : '—';
      return barRow({
        headLeft: escapeHtml(e.label),
        pct,
        color: '#D4A017',
        valueText,
        insideThreshold: 40, // texto "R$ 1.234,56 (100%)" só cabe dentro de barras bem cheias
      });
    })
    .join('');
  const payChartHtml = `<div class="bar-list">${payRows}</div>`;

  // ── Products chart ───────────────────────────────────────────────────────────
  const TOP_N = 8;
  const topSlice = r.topProducts.slice(0, TOP_N);
  const maxQty = topSlice.length > 0 ? topSlice[0].qty : 1;
  const LOW_OUTPUT_RATIO = 0.3; // qty <= 30% da saída do campeão => "baixa saída" (barra vermelha)

  const marginOf = (p: ProductStat): number | null =>
    p.hasCost && p.revenue > 0 ? ((p.revenue - p.cost) / p.revenue) * 100 : null;
  const marginColor = (m: number | null): string => {
    if (m == null) return '#8A8A8A';
    return m < 0 ? '#E74C3C' : '#DADADA';
  };

  let prodChartHtml: string;
  if (topSlice.length === 0) {
    prodChartHtml = `<p class="empty-note">Sem vendas no período.</p>`;
  } else {
    const prodRows = topSlice
      .map((p) => {
        const pct = maxQty > 0 ? (p.qty / maxQty) * 100 : 0;
        // Baixa saída => vermelho: sinaliza produto que não está gerando valor.
        const lowOutput = p.qty <= maxQty * LOW_OUTPUT_RATIO;
        const barColor = lowOutput ? '#E74C3C' : '#27AE60';
        // Margem do produto no canto direito da linha do nome (vermelha se prejuízo).
        const m = marginOf(p);
        const marginText = m == null ? 'margem —' : `margem ${Math.round(m)}%`;
        const marginFill = marginColor(m);
        return barRow({
          headLeft: escapeHtml(r.nameOf(p.id)), // nome completo — a elipse é CSS (text-overflow), sem truncar dados
          headRight: escapeHtml(marginText),
          headRightColor: marginFill,
          pct,
          color: barColor,
          valueText: String(p.qty),
          insideThreshold: 20, // valor é só um número curto, cabe dentro de barras menores
        });
      })
      .join('');

    const legend = `<p class="legend-note"><span class="legend-dot"></span>Baixa saída (≤ ${Math.round(LOW_OUTPUT_RATIO * 100)}% do campeão) — produto gerando pouco valor.</p>`;
    prodChartHtml = `<div class="bar-list">${prodRows}</div>${legend}`;
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório — ${escapeHtml(TYPE_LABELS[r.type] ?? r.type)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    background:#101010;
    color:#FFFFFF;
    min-height:100vh;
    -webkit-font-smoothing:antialiased;
  }

  /* Container central: no celular a tela já é estreita (~360-430px), então isto
     não muda nada visualmente — o relatório continua de ponta a ponta. No PWA/
     desktop, onde o mesmo HTML entra num iframe de tela cheia (1500-2500px+), é
     isto que trava o conteúdo num max-width e centraliza, em vez de esparramar.
     768px = 48rem = o max-w-3xl que o AppShell do PWA usa pra centralizar
     TODAS as outras telas em telas largas (src/app/AppShell.tsx) — o relatório
     usa o mesmo valor de propósito, pra ficar do mesmo tamanho que o resto do
     app no desktop, em vez de um "recibo" estreito perdido no fundo escuro. */
  .report{
    max-width:768px;
    margin:24px auto;
    background:#1A1A1A;
    border-radius:16px;
    overflow:hidden;
    box-shadow:0 12px 40px rgba(0,0,0,0.45);
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
    padding:14px;
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
    font-size:22px;
    font-weight:800;
    color:#D4A017;
    line-height:1.2;
    /* Sem nowrap/ellipsis: um valor em R$ nunca deve ficar ambíguo (dado
       financeiro). Se não couber numa linha só, quebra no espaço natural
       depois do "R$" — só recorre a quebrar o número em si (overflow-wrap:
       anywhere) se, mesmo assim, ele for largo demais para uma tela muito
       estreita. */
    overflow-wrap:anywhere;
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
    overflow:hidden;
  }

  /* Barras (HTML/CSS puro — ver comentário em renderHtml sobre o motivo de não
     usar mais SVG com viewBox esticável). Cada linha: nome+valor extra em cima,
     trilha+barra proporcional embaixo. A % de largura da barra é relativa ao
     próprio .bar-track (que por sua vez está dentro do .report, com max-width),
     então ela nunca "estica" texto — só a barra colorida muda de tamanho. */
  .bar-list{display:flex;flex-direction:column;gap:18px}
  .bar-row{min-width:0}
  .bar-row-head{
    display:flex;
    align-items:baseline;
    justify-content:space-between;
    gap:10px;
    margin-bottom:8px;
  }
  .bar-name{
    font-size:15px;
    font-weight:600;
    color:#DADADA;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    min-width:0;
  }
  .bar-margin{
    font-size:12.5px;
    font-weight:700;
    flex-shrink:0;
    white-space:nowrap;
  }
  .bar-line{
    display:flex;
    align-items:center;
    gap:10px;
  }
  .bar-track{
    flex:1;
    min-width:0;
    height:28px;
    background:#333333;
    border-radius:7px;
    overflow:hidden;
  }
  .bar-fill{
    height:100%;
    min-width:2px;
    border-radius:7px;
    display:flex;
    align-items:center;
    justify-content:flex-end;
    padding:0 10px;
    box-sizing:border-box;
  }
  .bar-fill .bar-value{
    color:#1A1A1A;
    font-size:14px;
    font-weight:700;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .bar-line > .bar-value{
    color:#DADADA;
    font-size:14px;
    font-weight:700;
    white-space:nowrap;
    flex-shrink:0;
  }
  .empty-note{color:#B0B0B0;font-size:15px}
  .legend-note{
    color:#B0B0B0;
    font-size:12px;
    margin-top:16px;
    line-height:1.5;
  }
  .legend-dot{
    display:inline-block;
    width:9px;
    height:9px;
    border-radius:2px;
    background:#E74C3C;
    margin-right:6px;
    vertical-align:middle;
  }

  /* Divider */
  .divider{height:1px;background:#333333;margin:20px 0}

  /* Footer */
  .footer{
    padding:20px 20px 24px;
    text-align:center;
    color:#B0B0B0;
    font-size:13px;
    line-height:1.7;
  }
  .footer strong{color:#D4A017}
</style>
</head>
<body>

<div class="report">
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
    <div class="kpi-value">${escapeHtml(brlBreakable(r.total))}</div>
  </div>
  <div class="kpi-row">
    <div class="kpi-card green">
      <div class="kpi-label">Vendas</div>
      <div class="kpi-value">${r.count}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Ticket Médio</div>
      <div class="kpi-value">${escapeHtml(brlBreakable(avgTicket))}</div>
    </div>
  </div>
  <div class="kpi-row">
    <div class="kpi-card ${profitClass}">
      <div class="kpi-label">Lucro (período)</div>
      <div class="kpi-value">${hasMargin ? escapeHtml(brlBreakable(r.profit)) : '—'}</div>
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
    ${payChartHtml}
  </div>
</div>

<!-- ═══ PRODUTOS ═══ -->
<div class="section">
  <div class="section-title">Produtos mais vendidos</div>
  <div class="chart-wrap">
    ${prodChartHtml}
  </div>
</div>

<!-- ═══ FOOTER ═══ -->
<div class="footer">
  ${hasMargin ? 'Margem sobre o preço do fornecedor preferido.<br>' : 'Cadastre o preço de compra dos produtos para ver a margem de lucro.<br>'}
  Gerado em <strong>${new Date().toLocaleString('pt-BR', { timeZone: TZ })}</strong><br>
  Sir Barbecue · PDV
</div>
</div>

</body>
</html>`;
}
