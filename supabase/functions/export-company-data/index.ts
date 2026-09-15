// Edge Function: export-company-data. SELF-CONTAINED (deployável pelo dashboard).
// O owner baixa TODOS os dados da própria empresa em CSV, empacotados num .zip:
// vendas, comandas, estoque, fornecedores/custo, produtos/categorias, pagamentos
// da assinatura e os relatórios HTML já gerados. Existe porque a decisão de
// manter a LEITURA aberta mesmo pra empresa inadimplente (MIGRATION_11, achado
// A06-01) foi justificada por "o cliente precisa conseguir exportar os próprios
// dados (LGPD e suporte)" — e essa exportação nunca tinha existido de fato.
// Pré-requisitos: MIGRATION_22_export_infra.sql (tabela data_exports, bucket
// exports, policy nova em payments). Plano: docs/exportacao-dados/PLANO_EXPORTACAO_DADOS.md.
//
// DEPLOY:
//   supabase functions deploy export-company-data
//
// Diferente de generate-report (owner|manager), aqui é SÓ OWNER: o zip carrega
// custo de fornecedor e histórico de cobrança da assinatura, dado mais sensível.
//
// LIMITE CONHECIDO: tudo roda numa única invocação (sem fila/job em background),
// mesmo modelo do generate-report. O schema já assume escala de Supabase free
// tier (~500MB) — não deve estourar o tempo de execução da function. Se um
// tenant crescer muito, aí sim vale redesenho assíncrono.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';
import JSZip from 'npm:jszip@3.10.1';

// Mesmo padrão de CORS das demais functions (ver invite-member/generate-report).
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGIN') ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = (req.headers.get('Origin') ?? '').replace(/\/+$/, '');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

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

// Igual generate-report/invite-member: resolve o tenant do chamador e valida
// que ele pertence a ele quando o corpo traz tenant_id explícito.
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
    if (!list.includes(requestedTenantId)) return null;
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

// ── CSV ──────────────────────────────────────────────────────────────────────
// RFC4180 simples, escrito à mão (não justifica trazer uma lib só pra isto):
// aspas quando o valor tem vírgula/aspas/quebra de linha, aspas internas dobradas.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(',');
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}

function nameOf(map: Map<string, string>, id: string | null | undefined): string {
  if (!id) return '';
  return map.get(id) ?? '';
}

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);
  const json = jsonFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = (await req.json().catch(() => ({}))) as {
      tenant_id?: string;
      from?: string;
      to?: string;
    };

    const caller = await getCallerTenant(req, body.tenant_id ?? null);
    if (!caller) return json({ error: 'Não autenticado ou sem acesso à empresa.' }, 401);

    const u = userClient(req); // RLS restringe à empresa do usuário

    // Exportação carrega custo de fornecedor e cobrança da assinatura: só owner
    // (mais estrito que generate-report, que aceita manager). Ver A01-02 na
    // auditoria pelo mesmo raciocínio de checar o papel ANTES de trabalhar.
    const { data: me } = await u
      .from('tenant_members')
      .select('role')
      .eq('tenant_id', caller.tenantId)
      .eq('user_id', caller.userId)
      .maybeSingle();
    if ((me as { role?: string } | null)?.role !== 'owner') {
      return json({ error: 'Apenas o dono (owner) pode exportar os dados da empresa.' }, 403);
    }

    // Período opcional — sem from/to, exporta o histórico INTEIRO (é dado de
    // portabilidade, não um relatório de período). Mesma validação de intervalo
    // de generate-report quando informado.
    let from: Date | null = null;
    let to: Date | null = null;
    if (body.from || body.to) {
      from = body.from ? new Date(body.from) : new Date(0);
      to = body.to ? new Date(body.to) : new Date();
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return json({ error: 'Datas inválidas.' }, 400);
      }
      if (from.getTime() > to.getTime()) {
        return json({ error: 'A data inicial deve ser anterior à final.' }, 400);
      }
      const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
      if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
        return json({ error: 'Intervalo máximo é de 1 ano.' }, 400);
      }
    }

    const tenantId = caller.tenantId;
    const zip = new JSZip();

    // ── Catálogo (buscado primeiro: dá nome aos ids nas outras planilhas) ──────
    const { data: categoriesData } = await u.from('categories').select('*').eq('tenant_id', tenantId);
    const categories = (categoriesData ?? []) as Record<string, unknown>[];
    const categoryNameOf = new Map(categories.map((c) => [c.client_id as string, c.name as string]));

    const { data: productsData } = await u.from('products').select('*').eq('tenant_id', tenantId);
    const products = (productsData ?? []) as Record<string, unknown>[];
    const productNameOf = new Map(products.map((p) => [p.client_id as string, p.name as string]));
    const productClientIds = products.map((p) => p.client_id as string);

    const { data: suppliersData } = await u.from('suppliers').select('*').eq('tenant_id', tenantId);
    const suppliers = (suppliersData ?? []) as Record<string, unknown>[];
    const supplierNameOf = new Map(suppliers.map((s) => [s.client_id as string, s.name as string]));

    zip.file(
      'categorias.csv',
      toCsv(categories, ['client_id', 'name', 'slug', 'display_order', 'created_at', 'updated_at']),
    );
    zip.file(
      'produtos.csv',
      toCsv(
        products.map((p) => ({ ...p, category_name: nameOf(categoryNameOf, p.category_client_id as string) })),
        ['client_id', 'name', 'description', 'category_client_id', 'category_name', 'price', 'is_active', 'created_at', 'updated_at'],
      ),
    );
    zip.file(
      'fornecedores.csv',
      toCsv(suppliers, ['client_id', 'name', 'contact_name', 'phone', 'address', 'created_at', 'updated_at']),
    );

    // ── Vendas e comandas ───────────────────────────────────────────────────
    let salesQuery = u.from('sales').select('*').eq('tenant_id', tenantId);
    if (from) salesQuery = salesQuery.gte('sale_date', from.toISOString());
    if (to) salesQuery = salesQuery.lte('sale_date', to.toISOString());
    const { data: salesData } = await salesQuery;
    const sales = (salesData ?? []) as Record<string, unknown>[];
    const saleClientIds = sales.map((s) => s.client_id as string);

    zip.file(
      'vendas.csv',
      toCsv(sales, [
        'client_id', 'total_amount', 'payment_method', 'consumption_mode',
        'sale_date', 'notes', 'synced_at', 'user_id', 'created_at', 'updated_at',
      ]),
    );

    const saleItems: Record<string, unknown>[] = [];
    const SALE_ITEMS_BATCH = 200; // .in() com muitos ids — evita URL gigante
    for (let i = 0; i < saleClientIds.length; i += SALE_ITEMS_BATCH) {
      const slice = saleClientIds.slice(i, i + SALE_ITEMS_BATCH);
      const { data } = await u.from('sale_items').select('*').in('sale_client_id', slice);
      saleItems.push(...((data ?? []) as Record<string, unknown>[]));
    }
    zip.file(
      'itens_venda.csv',
      toCsv(
        saleItems.map((it) => ({ ...it, product_name: nameOf(productNameOf, it.product_client_id as string) })),
        ['sale_client_id', 'product_client_id', 'product_name', 'quantity', 'unit_price', 'subtotal', 'updated_at'],
      ),
    );

    let tabsQuery = u.from('tabs').select('*').eq('tenant_id', tenantId);
    if (from) tabsQuery = tabsQuery.gte('opened_at', from.toISOString());
    if (to) tabsQuery = tabsQuery.lte('opened_at', to.toISOString());
    const { data: tabsData } = await tabsQuery;
    const tabs = (tabsData ?? []) as Record<string, unknown>[];
    const tabClientIds = tabs.map((t) => t.client_id as string);

    zip.file(
      'comandas.csv',
      toCsv(tabs, [
        'client_id', 'customer_name', 'status', 'opened_at', 'closed_at',
        'sale_client_id', 'user_id', 'updated_at',
      ]),
    );

    const tabItems: Record<string, unknown>[] = [];
    for (let i = 0; i < tabClientIds.length; i += SALE_ITEMS_BATCH) {
      const slice = tabClientIds.slice(i, i + SALE_ITEMS_BATCH);
      const { data } = await u.from('tab_items').select('*').in('tab_client_id', slice);
      tabItems.push(...((data ?? []) as Record<string, unknown>[]));
    }
    // tab_items já congela name/unit_price no momento da adição — não precisa resolver.
    zip.file(
      'itens_comanda.csv',
      toCsv(tabItems, ['tab_client_id', 'product_client_id', 'name', 'unit_price', 'quantity', 'updated_at']),
    );

    // ── Estoque ─────────────────────────────────────────────────────────────
    const { data: stockItemsData } = await u.from('stock_items').select('*').eq('tenant_id', tenantId);
    const stockItems = (stockItemsData ?? []) as Record<string, unknown>[];
    zip.file(
      'estoque_atual.csv',
      toCsv(
        stockItems.map((s) => ({ ...s, product_name: nameOf(productNameOf, s.product_client_id as string) })),
        ['client_id', 'product_client_id', 'product_name', 'quantity', 'alert_threshold', 'updated_at'],
      ),
    );

    let entriesQuery = u.from('stock_entries').select('*').eq('tenant_id', tenantId);
    if (from) entriesQuery = entriesQuery.gte('entry_date', from.toISOString());
    if (to) entriesQuery = entriesQuery.lte('entry_date', to.toISOString());
    const { data: stockEntriesData } = await entriesQuery;
    const stockEntries = (stockEntriesData ?? []) as Record<string, unknown>[];
    zip.file(
      'movimentacoes_estoque.csv',
      toCsv(
        stockEntries.map((e) => ({
          ...e,
          product_name: nameOf(productNameOf, e.product_client_id as string),
          supplier_name: nameOf(supplierNameOf, e.supplier_client_id as string),
        })),
        [
          'client_id', 'product_client_id', 'product_name', 'supplier_client_id', 'supplier_name',
          'quantity', 'entry_date', 'notes', 'user_id', 'updated_at',
        ],
      ),
    );

    // ── Fornecedor × produto (custo) ────────────────────────────────────────
    const productSuppliers: Record<string, unknown>[] = [];
    const priceHistory: Record<string, unknown>[] = [];
    for (let i = 0; i < productClientIds.length; i += SALE_ITEMS_BATCH) {
      const slice = productClientIds.slice(i, i + SALE_ITEMS_BATCH);
      const [{ data: ps }, { data: ph }] = await Promise.all([
        u.from('product_suppliers').select('*').in('product_client_id', slice),
        u.from('product_supplier_price_history').select('*').in('product_client_id', slice),
      ]);
      productSuppliers.push(...((ps ?? []) as Record<string, unknown>[]));
      priceHistory.push(...((ph ?? []) as Record<string, unknown>[]));
    }
    zip.file(
      'produtos_fornecedores.csv',
      toCsv(
        productSuppliers.map((p) => ({
          ...p,
          product_name: nameOf(productNameOf, p.product_client_id as string),
          supplier_name: nameOf(supplierNameOf, p.supplier_client_id as string),
        })),
        [
          'product_client_id', 'product_name', 'supplier_client_id', 'supplier_name',
          'purchase_price', 'is_preferred', 'is_active', 'updated_at',
        ],
      ),
    );
    zip.file(
      'historico_precos_fornecedor.csv',
      toCsv(
        priceHistory.map((p) => ({
          ...p,
          product_name: nameOf(productNameOf, p.product_client_id as string),
          supplier_name: nameOf(supplierNameOf, p.supplier_client_id as string),
        })),
        [
          'product_client_id', 'product_name', 'supplier_client_id', 'supplier_name',
          'purchase_price', 'is_preferred', 'recorded_at',
        ],
      ),
    );

    // ── Pagamentos da assinatura (via a policy nova da MIGRATION_22) ──────────
    let paymentsQuery = u.from('payments').select('*').eq('tenant_id', tenantId);
    if (from) paymentsQuery = paymentsQuery.gte('paid_at', from.toISOString());
    if (to) paymentsQuery = paymentsQuery.lte('paid_at', to.toISOString());
    const { data: paymentsData } = await paymentsQuery;
    const payments = (paymentsData ?? []) as Record<string, unknown>[];
    zip.file(
      'pagamentos_assinatura.csv',
      toCsv(payments, ['amount', 'method', 'paid_at', 'reference_month', 'status', 'created_at']),
    );

    // ── Relatórios já gerados (tabela + arquivos HTML do bucket `reports`) ────
    const { data: reportsData } = await u.from('reports').select('*').eq('tenant_id', tenantId);
    const reports = (reportsData ?? []) as Record<string, unknown>[];
    zip.file(
      'relatorios.csv',
      toCsv(reports, ['client_id', 'type', 'status', 'parameters', 'created_at', 'completed_at']),
    );

    const admin = adminClient();
    const { data: reportFiles } = await admin.storage.from('reports').list(tenantId, { limit: 1000 });
    if (reportFiles && reportFiles.length > 0) {
      const relFolder = zip.folder('relatorios');
      for (const f of reportFiles) {
        const { data: blob } = await admin.storage.from('reports').download(`${tenantId}/${f.name}`);
        if (blob) relFolder?.file(f.name, new Uint8Array(await blob.arrayBuffer()));
      }
    }

    const zipBytes = await zip.generateAsync({ type: 'uint8array' });

    const exportId = crypto.randomUUID();
    const path = `${tenantId}/${exportId}.zip`;

    // ORDEM: grava a linha em data_exports ANTES do upload — o INSERT passa pelo
    // cliente do usuário e portanto pela RLS (data_exports_owner_access), é a
    // última barreira de autorização. Mesma correção do generate-report (A01-02):
    // upload primeiro deixaria um zip com dado financeiro órfão no bucket se a
    // policy recusasse o INSERT depois.
    const { error: insErr } = await u.from('data_exports').insert({
      tenant_id: tenantId,
      client_id: exportId,
      status: 'ready',
      parameters: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      zip_url: path,
      completed_at: new Date().toISOString(),
    });
    if (insErr) throw insErr;

    const upload = await admin.storage.from('exports').upload(path, zipBytes, {
      contentType: 'application/zip',
      upsert: true,
    });
    if (upload.error) {
      await u.from('data_exports').delete().eq('client_id', exportId);
      throw upload.error;
    }

    return json({ exportId, path });
  } catch (e) {
    // A10-01: detalhe técnico só no log, mensagem genérica + ref pro usuário.
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[export-company-data ${ref}]`, e);
    return json({ error: 'Não foi possível gerar a exportação.', ref }, 400);
  }
});
