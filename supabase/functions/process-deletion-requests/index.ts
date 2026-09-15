// Edge Function: process-deletion-requests. SELF-CONTAINED (deployável pelo dashboard).
//
// Executa as solicitações de exclusão de conta que venceram (tabela
// `account_deletion_requests`, MIGRATION_24). É o par da `delete-account`, que
// apenas AGENDA. Quem exclui é esta função porque apagar de `auth.users` exige a
// SERVICE_ROLE_KEY, que não existe do lado do Postgres.
//
// DUAS ETAPAS, e a ordem entre elas é a regra de ouro da funcionalidade:
//   A) ENVIAR  — monta o .zip da empresa, sobe no Storage, gera link assinado de
//      7 dias e manda por e-mail. Registra o id do Resend.
//   B) EXCLUIR — só roda com export_status = 'delivered' (confirmado pelo webhook
//      `resend-webhook`) ou quando o cliente dispensou a exportação.
// Nunca apagar sem entregar: se o envio falhar, a solicitação segue pendente e é
// retentada; passados EXPORT_DELIVERY_TIMEOUT_DAYS sem confirmação (ou com bounce),
// vira 'failed' e some da fila automática, entrando na lista de contato manual do
// painel do dono. Nada é apagado nesse caminho.
//
// QUEM CHAMA:
//   • pg_cron -> run_due_account_deletions() -> pg_net, com ?token=<DELETION_WORKER_TOKEN>
//     (de hora em hora: a promessa de 48h é em horas);
//   • o painel do dono, com JWT de platform_admin e { requestId } no corpo, para
//     o botão "Excluir agora (não espera o prazo)".
//
// DEPLOY:
//   supabase functions deploy process-deletion-requests --no-verify-jwt
//   (sem JWT porque quem chama no caso normal é o Postgres, sem credencial do
//   Supabase; o modo painel valida o JWT por dentro, com is_platform_admin.)
//
// Secrets: DELETION_WORKER_TOKEN, RESEND_API_KEY, EMAIL_FROM.
//
// ⚠️ A montagem do .zip abaixo é uma CÓPIA da de `export-company-data/index.ts`.
// Duplicada de propósito: a convenção deste repositório é função SELF-CONTAINED,
// para poder ser colada no editor do dashboard (o padrão `_shared` com `../` só
// funciona pela CLI — ver o aviso no topo de supabase/functions/README.md).
// MUDOU O ZIP NUMA? MUDE NA OUTRA.
//
// Plano: docs/exportacao-dados/PLANO_EXCLUSAO_AGENDADA.md
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.112.4';
import JSZip from 'npm:jszip@3.10.1';

const WORKER_TOKEN = Deno.env.get('DELETION_WORKER_TOKEN') ?? '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? '';

// Validade do link mandado por e-mail. São 30 dias porque este arquivo é a ÚNICA
// cópia dos dados do cliente: a conta é apagada logo depois do envio, e não há de
// onde gerar outra. Uma janela curta transforma "não vi o e-mail a tempo" em
// perda definitiva — e o e-mail pode cair na aba Promoções do destinatário.
const SIGNED_URL_DAYS = 30;
const EXPORT_DELIVERY_TIMEOUT_DAYS = 5;
// A retenção do arquivo tem de ser MAIOR que a validade do link. Se fossem iguais,
// o último dia seria uma corrida entre a varredura e o clique do cliente — ele
// acharia um link anunciado como válido apontando para um arquivo já apagado.
// A folga de 15 dias também cobre um pedido de suporte depois do vencimento.
const DELETION_EXPORT_RETENTION_DAYS = 45;
// Quantos dias antes da purga o ex-membro é avisado de que a conta será encerrada.
const PURGE_WARNING_DAYS = 15;
const MAX_PER_RUN = 20; // teto por rodada: o cron roda de hora em hora
const BATCH = 200; // .in() com muitos ids — evita URL gigante

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );
}

// ── E-mail ───────────────────────────────────────────────────────────────────
// Mesmo cuidado do send-subscription-reminder (A05-01): o nome da empresa é
// editável pelo cliente e sai sob o domínio verificado do Sir Barbecue.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Nome com que o arquivo é SALVO no computador do cliente — ex.:
 * `sir-barbecue-espetinho-pani-2026-09-14.zip`.
 *
 * O caminho no bucket continua sendo o UUID da solicitação (estável e não
 * adivinhável); só o `Content-Disposition` muda, via parâmetro `download` da
 * signed URL. Sem isto o cliente baixa um arquivo chamado
 * `d1016d94-27bd-4f3a-....zip` e, meses depois, não faz ideia do que é.
 *
 * O nome da empresa é editável pelo cliente, então vira slug: sem acento, só
 * [a-z0-9-] e no máximo 40 caracteres. Isso também evita aspas e quebra de linha
 * chegarem ao cabeçalho HTTP.
 */
function exportFileName(tenantName: string, when: Date): string {
  const slug =
    tenantName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // remove acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'empresa';
  // en-CA formata como YYYY-MM-DD, que ordena certo no explorador de arquivos.
  const data = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Sao_Paulo',
  }).format(when);
  return `sir-barbecue-${slug}-${data}.zip`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(d);
}

/**
 * Corpo do e-mail. Escrito de propósito como mensagem TRANSACIONAL, não como
 * campanha: sem imagem, sem botão estilizado, sem saudação de marketing. Um
 * e-mail com cara de promoção cai na aba Promoções do Gmail — e este carrega a
 * ÚNICA cópia dos dados do cliente, então não ser visto é perda definitiva.
 *
 * O texto também corrige um erro da primeira versão, que dizia "o link expira em
 * X e a conta será excluída em seguida": dava a entender que a exclusão só
 * aconteceria quando o link vencesse. A conta é apagada logo depois deste e-mail
 * (na passada seguinte do cron); o link é que sobrevive por semanas.
 */
function buildEmailHtml(rawTenantName: string, url: string, expiresAt: string): string {
  const tenantName = escapeHtml(rawTenantName).slice(0, 120);
  const safeUrl = escapeHtml(url);
  return `
    <p>Você pediu a exclusão da sua conta no Sir Barbecue e solicitou uma cópia dos dados da
    empresa <strong>${tenantName}</strong>. Ela está no arquivo abaixo.</p>
    <p><a href="${safeUrl}">Baixar os dados da empresa (.zip)</a></p>
    <p>O arquivo tem uma planilha (.csv) para cada parte do histórico: vendas, itens de venda,
    comandas, estoque, movimentações, fornecedores e custos, produtos, categorias, pagamentos da
    assinatura e os relatórios já gerados.</p>
    <p><strong>A exclusão da conta e de todos os dados da empresa acontece agora</strong>, logo
    após este envio, e não há como recuperar depois.</p>
    <p>Este link funciona até <strong>${expiresAt}</strong>. Guarde o arquivo antes disso: passada
    essa data ele deixa de existir, e não há mais de onde gerar outra cópia.</p>
    <p>Se o link não abrir, copie e cole este endereço no navegador:<br>${safeUrl}</p>
  `.trim();
}

/**
 * E-mail da EXPORTAÇÃO AVULSA (o cliente pediu uma cópia pelo menu, sem excluir
 * a conta). Texto necessariamente diferente do da exclusão: dizer "a conta será
 * apagada agora" para quem só queria um backup seria assustador e falso.
 */
function buildExportEmailHtml(rawTenantName: string, url: string, expiresAt: string): string {
  const tenantName = escapeHtml(rawTenantName).slice(0, 120);
  const safeUrl = escapeHtml(url);
  return `
    <p>Aqui está a cópia dos dados da empresa <strong>${tenantName}</strong> que você pediu no
    Sir Barbecue.</p>
    <p><a href="${safeUrl}">Baixar os dados da empresa (.zip)</a></p>
    <p>O arquivo tem uma planilha (.csv) para cada parte do histórico: vendas, itens de venda,
    comandas, estoque, movimentações, fornecedores e custos, produtos, categorias, pagamentos da
    assinatura e os relatórios já gerados.</p>
    <p>Este link funciona até <strong>${expiresAt}</strong>. Depois dessa data ele deixa de valer —
    mas sua conta continua normal, e você pode pedir uma cópia nova quando quiser, em
    Mais &gt; Exportar dados.</p>
    <p>Se o link não abrir, copie e cole este endereço no navegador:<br>${safeUrl}</p>
  `.trim();
}

function buildExportEmailText(rawTenantName: string, url: string, expiresAt: string): string {
  return [
    `Aqui está a cópia dos dados da empresa ${rawTenantName.slice(0, 120)} que você pediu no Sir Barbecue.`,
    '',
    'Baixe o arquivo (.zip) neste endereço:',
    url,
    '',
    'O arquivo tem uma planilha (.csv) para cada parte do histórico: vendas, itens de venda,',
    'comandas, estoque, movimentações, fornecedores e custos, produtos, categorias, pagamentos',
    'da assinatura e os relatórios já gerados.',
    '',
    `Este link funciona até ${expiresAt}. Depois dessa data ele deixa de valer — mas sua conta`,
    'continua normal, e você pode pedir uma cópia nova quando quiser, em Mais > Exportar dados.',
  ].join('\n');
}

/**
 * Versão em texto puro. Vai junto com o HTML (multipart): melhora a classificação
 * do e-mail e atende quem lê em cliente sem HTML.
 */
function buildEmailText(rawTenantName: string, url: string, expiresAt: string): string {
  const tenantName = rawTenantName.slice(0, 120);
  return [
    `Você pediu a exclusão da sua conta no Sir Barbecue e solicitou uma cópia dos dados da empresa ${tenantName}.`,
    '',
    'Baixe o arquivo (.zip) neste endereço:',
    url,
    '',
    'O arquivo tem uma planilha (.csv) para cada parte do histórico: vendas, itens de venda,',
    'comandas, estoque, movimentações, fornecedores e custos, produtos, categorias, pagamentos',
    'da assinatura e os relatórios já gerados.',
    '',
    'A exclusão da conta e de todos os dados da empresa acontece agora, logo após este envio,',
    'e não há como recuperar depois.',
    '',
    `Este link funciona até ${expiresAt}. Guarde o arquivo antes disso: passada essa data ele`,
    'deixa de existir, e não há mais de onde gerar outra cópia.',
  ].join('\n');
}

/**
 * E-mail para o EX-MEMBRO, no momento em que a empresa é excluída (MIGRATION_26).
 *
 * Ele não pediu nada e vai abrir o app no meio do expediente e encontrar tudo
 * travado. O texto precisa responder três coisas, nesta ordem: o que aconteceu,
 * que a conta dele continua dele, e o que ele pode fazer. Nada sobre os dados da
 * empresa — aquilo não é assunto dele, e a empresa pediu para sumir.
 */
function buildOrphanNoticeHtml(purgeDate: string): string {
  return `
    <p>A empresa em que você usava o Sir Barbecue encerrou a conta, e por isso o seu acesso a ela
    terminou.</p>
    <p><strong>A sua conta continua sendo sua.</strong> Ela não foi excluída: se alguém te adicionar
    a outra empresa, é só entrar com o mesmo e-mail e senha de sempre.</p>
    <p>Se preferir não esperar, você pode excluir a sua conta a qualquer momento pelo próprio app,
    na tela que aparece ao entrar.</p>
    <p>Caso nada mude, encerramos contas sem empresa vinculada depois de 6 meses — no seu caso, a
    partir de <strong>${purgeDate}</strong>. Avisamos por e-mail antes disso.</p>
  `.trim();
}

function buildOrphanNoticeText(purgeDate: string): string {
  return [
    'A empresa em que você usava o Sir Barbecue encerrou a conta, e por isso o seu acesso a ela terminou.',
    '',
    'A SUA conta continua sendo sua. Ela não foi excluída: se alguém te adicionar a outra empresa,',
    'é só entrar com o mesmo e-mail e senha de sempre.',
    '',
    'Se preferir não esperar, você pode excluir a sua conta a qualquer momento pelo próprio app,',
    'na tela que aparece ao entrar.',
    '',
    `Caso nada mude, encerramos contas sem empresa vinculada depois de 6 meses — no seu caso, a`,
    `partir de ${purgeDate}. Avisamos por e-mail antes disso.`,
  ].join('\n');
}

/** Aviso dos 15 dias antes da purga. */
function buildPurgeWarningHtml(purgeDate: string): string {
  return `
    <p>Sua conta no Sir Barbecue está sem empresa vinculada desde que a empresa que você usava
    encerrou a conta dela.</p>
    <p>Como não houve movimentação desde então, vamos <strong>encerrar a sua conta em
    ${purgeDate}</strong>, junto com o seu cadastro.</p>
    <p>Para manter a conta, basta ser adicionado a alguma empresa antes dessa data — quem administra
    a empresa faz isso pelo app, e você entra normalmente depois. Se preferir, fale com a gente
    respondendo este e-mail.</p>
    <p>Se não quiser fazer nada, não precisa responder: a conta é encerrada na data acima.</p>
  `.trim();
}

function buildPurgeWarningText(purgeDate: string): string {
  return [
    'Sua conta no Sir Barbecue está sem empresa vinculada desde que a empresa que você usava',
    'encerrou a conta dela.',
    '',
    `Como não houve movimentação desde então, vamos encerrar a sua conta em ${purgeDate},`,
    'junto com o seu cadastro.',
    '',
    'Para manter a conta, basta ser adicionado a alguma empresa antes dessa data — quem administra',
    'a empresa faz isso pelo app, e você entra normalmente depois. Se preferir, fale com a gente',
    'respondendo este e-mail.',
    '',
    'Se não quiser fazer nada, não precisa responder: a conta é encerrada na data acima.',
  ].join('\n');
}

// ── CSV (cópia de export-company-data) ───────────────────────────────────────
// RFC4180 simples: aspas quando o valor tem vírgula/aspas/quebra de linha,
// aspas internas dobradas.
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

type Row = Record<string, unknown>;

async function fetchInBatches(
  db: SupabaseClient,
  table: string,
  column: string,
  ids: string[],
): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data } = await db.from(table).select('*').in(column, ids.slice(i, i + BATCH));
    out.push(...((data ?? []) as Row[]));
  }
  return out;
}

/**
 * Monta o .zip com TODOS os dados da empresa. Usa o cliente admin (service_role):
 * quem dispara aqui é o cron, não há sessão de usuário para a RLS avaliar — a
 * autorização já aconteceu quando o dono da conta solicitou a exclusão com senha.
 */
async function buildCompanyExportZip(admin: SupabaseClient, tenantId: string): Promise<Uint8Array> {
  const zip = new JSZip();

  // Catálogo primeiro: dá nome aos ids nas outras planilhas (um dono não-técnico
  // não consegue usar uma planilha só com UUID).
  const { data: categoriesData } = await admin.from('categories').select('*').eq('tenant_id', tenantId);
  const categories = (categoriesData ?? []) as Row[];
  const categoryNameOf = new Map(categories.map((c) => [c.client_id as string, c.name as string]));

  const { data: productsData } = await admin.from('products').select('*').eq('tenant_id', tenantId);
  const products = (productsData ?? []) as Row[];
  const productNameOf = new Map(products.map((p) => [p.client_id as string, p.name as string]));
  const productClientIds = products.map((p) => p.client_id as string);

  const { data: suppliersData } = await admin.from('suppliers').select('*').eq('tenant_id', tenantId);
  const suppliers = (suppliersData ?? []) as Row[];
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

  const { data: salesData } = await admin.from('sales').select('*').eq('tenant_id', tenantId);
  const sales = (salesData ?? []) as Row[];
  zip.file(
    'vendas.csv',
    toCsv(sales, [
      'client_id', 'total_amount', 'payment_method', 'consumption_mode',
      'sale_date', 'notes', 'synced_at', 'user_id', 'created_at', 'updated_at',
    ]),
  );

  const saleItems = await fetchInBatches(admin, 'sale_items', 'sale_client_id', sales.map((s) => s.client_id as string));
  zip.file(
    'itens_venda.csv',
    toCsv(
      saleItems.map((it) => ({ ...it, product_name: nameOf(productNameOf, it.product_client_id as string) })),
      ['sale_client_id', 'product_client_id', 'product_name', 'quantity', 'unit_price', 'subtotal', 'updated_at'],
    ),
  );

  const { data: tabsData } = await admin.from('tabs').select('*').eq('tenant_id', tenantId);
  const tabs = (tabsData ?? []) as Row[];
  zip.file(
    'comandas.csv',
    toCsv(tabs, ['client_id', 'customer_name', 'status', 'opened_at', 'closed_at', 'sale_client_id', 'user_id', 'updated_at']),
  );

  const tabItems = await fetchInBatches(admin, 'tab_items', 'tab_client_id', tabs.map((t) => t.client_id as string));
  // tab_items já congela name/unit_price no momento da adição — não precisa resolver.
  zip.file(
    'itens_comanda.csv',
    toCsv(tabItems, ['tab_client_id', 'product_client_id', 'name', 'unit_price', 'quantity', 'updated_at']),
  );

  const { data: stockItemsData } = await admin.from('stock_items').select('*').eq('tenant_id', tenantId);
  zip.file(
    'estoque_atual.csv',
    toCsv(
      ((stockItemsData ?? []) as Row[]).map((s) => ({ ...s, product_name: nameOf(productNameOf, s.product_client_id as string) })),
      ['client_id', 'product_client_id', 'product_name', 'quantity', 'alert_threshold', 'updated_at'],
    ),
  );

  const { data: stockEntriesData } = await admin.from('stock_entries').select('*').eq('tenant_id', tenantId);
  zip.file(
    'movimentacoes_estoque.csv',
    toCsv(
      ((stockEntriesData ?? []) as Row[]).map((e) => ({
        ...e,
        product_name: nameOf(productNameOf, e.product_client_id as string),
        supplier_name: nameOf(supplierNameOf, e.supplier_client_id as string),
      })),
      ['client_id', 'product_client_id', 'product_name', 'supplier_client_id', 'supplier_name', 'quantity', 'entry_date', 'notes', 'user_id', 'updated_at'],
    ),
  );

  const productSuppliers = await fetchInBatches(admin, 'product_suppliers', 'product_client_id', productClientIds);
  const priceHistory = await fetchInBatches(admin, 'product_supplier_price_history', 'product_client_id', productClientIds);
  zip.file(
    'produtos_fornecedores.csv',
    toCsv(
      productSuppliers.map((p) => ({
        ...p,
        product_name: nameOf(productNameOf, p.product_client_id as string),
        supplier_name: nameOf(supplierNameOf, p.supplier_client_id as string),
      })),
      ['product_client_id', 'product_name', 'supplier_client_id', 'supplier_name', 'purchase_price', 'is_preferred', 'is_active', 'updated_at'],
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
      ['product_client_id', 'product_name', 'supplier_client_id', 'supplier_name', 'purchase_price', 'is_preferred', 'recorded_at'],
    ),
  );

  const { data: paymentsData } = await admin.from('payments').select('*').eq('tenant_id', tenantId);
  zip.file(
    'pagamentos_assinatura.csv',
    toCsv((paymentsData ?? []) as Row[], ['amount', 'method', 'paid_at', 'reference_month', 'status', 'created_at']),
  );

  const { data: reportsData } = await admin.from('reports').select('*').eq('tenant_id', tenantId);
  zip.file(
    'relatorios.csv',
    toCsv((reportsData ?? []) as Row[], ['client_id', 'type', 'status', 'parameters', 'created_at', 'completed_at']),
  );

  const { data: reportFiles } = await admin.storage.from('reports').list(tenantId, { limit: 1000 });
  if (reportFiles && reportFiles.length > 0) {
    const relFolder = zip.folder('relatorios');
    for (const f of reportFiles) {
      const { data: blob } = await admin.storage.from('reports').download(`${tenantId}/${f.name}`);
      if (blob) relFolder?.file(f.name, new Uint8Array(await blob.arrayBuffer()));
    }
  }

  return await zip.generateAsync({ type: 'uint8array' });
}

/**
 * Apaga a pasta `<tenant_id>/` da empresa num bucket (`reports` ou `exports`).
 * Cópia da que existia na delete-account, com uma diferença: IGNORA entradas de
 * subpasta (id === null). É o que preserva `<tenant_id>/deletions/<id>.zip`, o zip
 * que acabou de ser enviado por e-mail — apagá-lo aqui quebraria o link de 7 dias
 * que o cliente recebeu minutos antes.
 *
 * Lista e apaga em rodadas, sempre do início: como cada rodada remove o que
 * listou, paginar por offset pularia arquivos (a lista encolhe a cada remoção).
 */
async function deleteTenantBucketFolder(
  admin: SupabaseClient,
  bucket: string,
  tenantId: string,
): Promise<void> {
  const PAGE = 100;
  const MAX_ROUNDS = 100; // teto de segurança: 10.000 arquivos por empresa

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { data, error } = await admin.storage.from(bucket).list(tenantId, { limit: PAGE });
    if (error) throw error;

    const names = (data ?? [])
      .filter((f) => (f as { id?: string | null }).id !== null) // pula subpastas
      .map((f) => `${tenantId}/${f.name}`);
    if (names.length === 0) return; // só sobrou subpasta (ou já está limpo) — fim

    const { error: rmErr } = await admin.storage.from(bucket).remove(names);
    if (rmErr) throw rmErr;
  }

  throw new Error(`limpeza do bucket ${bucket} não terminou para o tenant ${tenantId}`);
}

type DeletionRequest = {
  id: string;
  tenant_id: string | null;
  tenant_name: string;
  requested_by: string;
  export_requested: boolean;
  export_status: string;
  export_sent_at: string | null;
  contact_email: string | null;
  scheduled_for: string;
};

/** ETAPA A — monta, sobe, envia e registra o id do e-mail. */
async function sendExport(admin: SupabaseClient, r: DeletionRequest): Promise<void> {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    throw new Error('RESEND_API_KEY/EMAIL_FROM não configurados');
  }
  if (!r.tenant_id) throw new Error('solicitação sem tenant_id');
  if (!r.contact_email) throw new Error('solicitação sem e-mail de contato');

  const zipBytes = await buildCompanyExportZip(admin, r.tenant_id);

  // Subpasta DENTRO da pasta da empresa: a policy do bucket `exports` faz
  // `foldername[1]::uuid`, então uma pasta 'deletions/' na raiz quebraria a
  // leitura do bucket inteiro (MIGRATION_22).
  const path = `${r.tenant_id}/deletions/${r.id}.zip`;
  const upload = await admin.storage.from('exports').upload(path, zipBytes, {
    contentType: 'application/zip',
    upsert: true,
  });
  if (upload.error) throw upload.error;

  const expiresIn = SIGNED_URL_DAYS * 24 * 60 * 60;
  const { data: signed, error: signErr } = await admin.storage
    .from('exports')
    .createSignedUrl(path, expiresIn, {
      // Define o Content-Disposition: o cliente salva com um nome que ele
      // reconhece, não com o UUID da solicitação.
      download: exportFileName(r.tenant_name, new Date()),
    });
  if (signErr || !signed?.signedUrl) throw signErr ?? new Error('signed URL vazia');

  const expiresAt = formatDate(new Date(Date.now() + expiresIn * 1000).toISOString());
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [r.contact_email],
      // Assunto transacional, com o prazo: diz o que é e o que fazer. Evita
      // linguagem de campanha, que empurra o e-mail para a aba Promoções.
      subject: `Sua cópia de dados do Sir Barbecue — baixe até ${expiresAt}`,
      html: buildEmailHtml(r.tenant_name, signed.signedUrl, expiresAt),
      text: buildEmailText(r.tenant_name, signed.signedUrl, expiresAt),
    }),
  });
  if (!res.ok) throw new Error(`Resend respondeu ${res.status}: ${await res.text()}`);

  const sent = (await res.json().catch(() => ({}))) as { id?: string };

  await admin
    .from('account_deletion_requests')
    .update({
      export_status: 'sent',
      export_email_id: sent.id ?? null,
      export_email_status: 'sent',
      export_sent_at: new Date().toISOString(),
      export_zip_path: path,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', r.id);
}

/** ETAPA B — apaga de verdade. Só é chamada com a entrega confirmada. */
async function executeDeletion(admin: SupabaseClient, r: DeletionRequest): Promise<void> {
  const tenantId = r.tenant_id;

  // BANCO PRIMEIRO. `delete_tenant_cascade` apaga as filhas em ordem EXPLÍCITA
  // (MIGRATION_19/21/22/24) e marca esta solicitação como 'completed', apagando o
  // contato. O delete direto em `tenants` NUNCA funcionou para empresa com vendas.
  if (tenantId) {
    const { error } = await admin.rpc('delete_tenant_cascade', { p_tenant_id: tenantId });
    if (error) throw error;
  }

  // SOFT DELETE do vínculo (MIGRATION_21) nas empresas em que o usuário era apenas
  // membro: a linha é o ATOR do histórico do patrão, que não pediu exclusão.
  const { error: memberErr } = await admin
    .from('tenant_members')
    .update({ removed_at: new Date().toISOString() })
    .eq('user_id', r.requested_by)
    .is('removed_at', null);
  if (memberErr) throw memberErr;

  // O usuário do Auth só sai quando NENHUMA outra solicitação dele segue aberta —
  // um dono com duas empresas tem duas linhas, e apagar o usuário na primeira
  // deixaria a segunda órfã.
  const { data: pendingOthers } = await admin
    .from('account_deletion_requests')
    .select('id')
    .eq('requested_by', r.requested_by)
    .in('status', ['pending', 'failed'])
    .neq('id', r.id)
    .limit(1);

  if (!pendingOthers || pendingOthers.length === 0) {
    const { error: delErr } = await admin.auth.admin.deleteUser(r.requested_by);
    // Usuário já removido numa rodada anterior não é erro que deva reverter nada.
    if (delErr && !/not found/i.test(delErr.message ?? '')) throw delErr;
  }

  // STORAGE POR ÚLTIMO e sem derrubar a exclusão: o banco já foi. Se a limpeza
  // falhar, sobram órfãos — ruim, mas muito melhor que o inverso, que esta função
  // já cometeu uma vez em 07/09/2026 (apagar arquivos e falhar no banco depois;
  // Storage não faz rollback). O erro vai para o log com os ids.
  if (tenantId) {
    for (const bucket of ['reports', 'exports']) {
      try {
        await deleteTenantBucketFolder(admin, bucket, tenantId);
      } catch (storageErr) {
        console.error(`[process-deletion-requests] limpeza de ${bucket}/${tenantId} falhou`, storageErr);
      }
    }
  }
}

/** Decide o que fazer com UMA solicitação. Devolve o que aconteceu, para o log. */
async function processOne(admin: SupabaseClient, r: DeletionRequest): Promise<string> {
  if (!r.export_requested) {
    await executeDeletion(admin, r);
    return 'deleted';
  }

  if (r.export_status === 'delivered') {
    await executeDeletion(admin, r);
    return 'deleted';
  }

  if (r.export_status === 'sent') {
    // Enviado, aguardando o webhook confirmar. Passado o limite, tira da fila
    // automática e entrega ao contato manual do dono — sem apagar nada.
    const sentAt = r.export_sent_at ? new Date(r.export_sent_at).getTime() : 0;
    const limit = EXPORT_DELIVERY_TIMEOUT_DAYS * 24 * 60 * 60 * 1000;
    if (sentAt > 0 && Date.now() - sentAt > limit) {
      await admin
        .from('account_deletion_requests')
        .update({
          status: 'failed',
          last_error: `Entrega do e-mail não confirmada em ${EXPORT_DELIVERY_TIMEOUT_DAYS} dias.`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', r.id);
      return 'delivery_timeout';
    }
    return 'awaiting_delivery';
  }

  // 'pending' / 'not_requested' / 'failed' -> tenta enviar (ou reenviar).
  await sendExport(admin, r);
  return 'sent';
}

type ExportRequest = {
  id: string;
  tenant_id: string;
  client_id: string;
  contact_email: string | null;
};

/**
 * FILA 2 — exportação avulsa (MIGRATION_25). O cliente pediu uma cópia pelo menu
 * e continua com a conta ativa: aqui não se apaga nada, só monta, envia e
 * registra.
 *
 * Mora neste worker, e não numa função própria, para não existir uma TERCEIRA
 * cópia do construtor de zip — e porque o cron horário já passa por aqui.
 *
 * Diferente da exportação da exclusão, o arquivo vai na pasta normal da empresa
 * (`<tenant_id>/<client_id>.zip`, igual à função síncrona antiga): a empresa não
 * está sendo apagada, então não há motivo para escapar da limpeza por tenant.
 */
async function processExportRequest(admin: SupabaseClient, r: ExportRequest): Promise<string> {
  if (!RESEND_API_KEY || !EMAIL_FROM) throw new Error('RESEND_API_KEY/EMAIL_FROM não configurados');
  if (!r.contact_email) throw new Error('solicitação sem e-mail de contato');

  const { data: tenant } = await admin
    .from('tenants')
    .select('name')
    .eq('id', r.tenant_id)
    .maybeSingle();
  const tenantName = (tenant as { name?: string } | null)?.name ?? 'sua empresa';

  const zipBytes = await buildCompanyExportZip(admin, r.tenant_id);
  const path = `${r.tenant_id}/${r.client_id}.zip`;

  const upload = await admin.storage.from('exports').upload(path, zipBytes, {
    contentType: 'application/zip',
    upsert: true,
  });
  if (upload.error) throw upload.error;

  const expiresIn = SIGNED_URL_DAYS * 24 * 60 * 60;
  const { data: signed, error: signErr } = await admin.storage
    .from('exports')
    .createSignedUrl(path, expiresIn, { download: exportFileName(tenantName, new Date()) });
  if (signErr || !signed?.signedUrl) throw signErr ?? new Error('signed URL vazia');

  const expiresAt = formatDate(new Date(Date.now() + expiresIn * 1000).toISOString());
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [r.contact_email],
      subject: `Sua cópia de dados do Sir Barbecue — baixe até ${expiresAt}`,
      html: buildExportEmailHtml(tenantName, signed.signedUrl, expiresAt),
      text: buildExportEmailText(tenantName, signed.signedUrl, expiresAt),
    }),
  });
  if (!res.ok) throw new Error(`Resend respondeu ${res.status}: ${await res.text()}`);

  const sent = (await res.json().catch(() => ({}))) as { id?: string };

  await admin
    .from('data_exports')
    .update({
      status: 'sent',
      zip_url: path,
      email_id: sent.id ?? null,
      email_status: 'sent',
      sent_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', r.id);

  return 'sent';
}

/** Processa a fila de exportações avulsas, isolando a falha de cada uma. */
async function processExportQueue(admin: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await admin
    .from('data_exports')
    .select('id, tenant_id, client_id, contact_email')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) throw error;

  const results: Record<string, string> = {};
  for (const r of (data ?? []) as ExportRequest[]) {
    try {
      results[r.id] = await processExportRequest(admin, r);
    } catch (e) {
      results[r.id] = 'error';
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[process-deletion-requests] exportação ${r.id} falhou`, e);
      await admin
        .from('data_exports')
        .update({
          status: 'failed',
          error_message: message.slice(0, 500),
          updated_at: new Date().toISOString(),
        })
        .eq('id', r.id);
    }
  }
  return results;
}

type FormerMember = {
  id: string;
  user_id: string;
  occurred_at: string;
  notified_at: string | null;
  warning_sent_at: string | null;
  purge_after: string;
};

/** Ainda está sem empresa? Quem foi adicionado a outra no meio do caminho sai da fila. */
async function aindaOrfao(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await admin
    .from('tenant_members')
    .select('id')
    .eq('user_id', userId)
    .is('removed_at', null)
    .limit(1);
  return !data || data.length === 0;
}

async function enviarEmail(
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<void> {
  if (!RESEND_API_KEY || !EMAIL_FROM) throw new Error('RESEND_API_KEY/EMAIL_FROM não configurados');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend respondeu ${res.status}: ${await res.text()}`);
}

/**
 * FILA 3 — contas órfãs (MIGRATION_26). Três coisas, em ordem de urgência:
 *   a) avisar quem acabou de perder o vínculo porque a empresa foi excluída;
 *   b) avisar, 15 dias antes, que a conta sem empresa será encerrada;
 *   c) encerrar, passados os 6 meses.
 *
 * Todo passo reconfere o vínculo ANTES de agir: quem foi adicionado a outra
 * empresa nesse meio-tempo deixa de ser órfão e não pode ser apagado.
 */
async function processOrphanQueue(admin: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await admin
    .from('former_members')
    .select('id, user_id, occurred_at, notified_at, warning_sent_at, purge_after')
    .is('purged_at', null)
    .order('occurred_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) throw error;

  const results: Record<string, string> = {};
  const agora = Date.now();

  for (const r of (data ?? []) as FormerMember[]) {
    try {
      const { data: userData } = await admin.auth.admin.getUserById(r.user_id);
      const email = userData?.user?.email;
      if (!email) {
        // Conta já não existe (ele mesmo excluiu). A linha cascateia sozinha.
        results[r.id] = 'sem_usuario';
        continue;
      }

      const purgeDate = formatDate(r.purge_after);

      if (!r.notified_at) {
        await enviarEmail(
          email,
          'Sua conta no Sir Barbecue continua ativa — a empresa é que encerrou',
          buildOrphanNoticeHtml(purgeDate),
          buildOrphanNoticeText(purgeDate),
        );
        await admin
          .from('former_members')
          .update({ notified_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
          .eq('id', r.id);
        results[r.id] = 'avisado';
        continue;
      }

      const venceu = new Date(r.purge_after).getTime();
      const janelaAviso = venceu - PURGE_WARNING_DAYS * 24 * 60 * 60 * 1000;

      if (!r.warning_sent_at && agora >= janelaAviso) {
        if (!(await aindaOrfao(admin, r.user_id))) {
          results[r.id] = 'reintegrado';
          continue;
        }
        await enviarEmail(
          email,
          `Sua conta no Sir Barbecue será encerrada em ${purgeDate}`,
          buildPurgeWarningHtml(purgeDate),
          buildPurgeWarningText(purgeDate),
        );
        await admin
          .from('former_members')
          .update({ warning_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', r.id);
        results[r.id] = 'aviso_de_purga';
        continue;
      }

      if (agora >= venceu) {
        // Última conferência antes de apagar a conta de alguém que não pediu.
        if (!(await aindaOrfao(admin, r.user_id))) {
          results[r.id] = 'reintegrado';
          continue;
        }
        const { error: delErr } = await admin.auth.admin.deleteUser(r.user_id);
        if (delErr && !/not found/i.test(delErr.message ?? '')) throw delErr;
        // A linha cascateia com o usuário; o update abaixo é só para o caso de o
        // delete ter sido no-op (usuário já ausente).
        await admin
          .from('former_members')
          .update({ purged_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', r.id);
        results[r.id] = 'purgado';
        continue;
      }

      results[r.id] = 'aguardando';
    } catch (e) {
      results[r.id] = 'error';
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[process-deletion-requests] órfão ${r.id} falhou`, e);
      await admin
        .from('former_members')
        .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString() })
        .eq('id', r.id);
    }
  }
  return results;
}

/**
 * Varredura de retenção dos zips de exclusão. O link vale 30 dias; guardamos 45,
 * porque a retenção tem de sobreviver ao link. Depois disso o arquivo some — ele
 * contém faturamento, custo de fornecedor e cobrança de assinatura de uma empresa
 * que já não existe.
 */
async function cleanupOldDeletionExports(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - DELETION_EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { data } = await admin
    .from('account_deletion_requests')
    .select('id, export_zip_path')
    .not('export_zip_path', 'is', null)
    .lt('completed_at', cutoff.toISOString())
    .limit(100);

  const rows = (data ?? []) as { id: string; export_zip_path: string }[];
  if (rows.length === 0) return 0;

  const { error } = await admin.storage.from('exports').remove(rows.map((r) => r.export_zip_path));
  if (error) {
    console.error('[process-deletion-requests] limpeza de zips antigos falhou', error);
    return 0;
  }

  await admin
    .from('account_deletion_requests')
    .update({ export_zip_path: null, updated_at: new Date().toISOString() })
    .in('id', rows.map((r) => r.id));

  return rows.length;
}

/**
 * Autoriza a chamada e diz QUAIS solicitações processar.
 * Dois modos: token do cron (todas as vencidas) ou admin do painel (uma só).
 */
async function authorize(req: Request): Promise<
  { ok: true; requestId: string | null } | { ok: false; response: Response }
> {
  const token = new URL(req.url).searchParams.get('token');

  if (token !== null) {
    // Fail-closed: sem segredo configurado, ninguém dispara exclusão.
    if (!WORKER_TOKEN) {
      console.error('[process-deletion-requests] DELETION_WORKER_TOKEN não configurada — recusando.');
      return { ok: false, response: textResponse('not configured', 503) };
    }
    // 404 para não confirmar a existência do endpoint a quem varre.
    if (token !== WORKER_TOKEN) return { ok: false, response: textResponse('Not Found', 404) };
    return { ok: true, requestId: null };
  }

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth) return { ok: false, response: textResponse('Not Found', 404) };

  const u = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: isAdmin } = await u.rpc('is_platform_admin');
  if (isAdmin !== true) return { ok: false, response: json({ error: 'forbidden' }, 403) };

  const body = (await req.json().catch(() => ({}))) as { requestId?: string };
  if (!body.requestId) return { ok: false, response: json({ error: 'requestId é obrigatório' }, 400) };
  return { ok: true, requestId: body.requestId };
}

const SELECT_COLUMNS =
  'id, tenant_id, tenant_name, requested_by, export_requested, export_status, export_sent_at, contact_email, scheduled_for';

/**
 * Escolhe QUAIS exclusões processar nesta chamada.
 *  • modo painel ("Excluir agora"): uma só, ignorando o prazo — mas NÃO a trava
 *    de entrega. A tela desabilita o botão; esta checagem é a que vale, porque
 *    apagar os dados de quem pediu uma cópia deles, sem a cópia ter chegado, é o
 *    erro mais caro que esta funcionalidade pode cometer.
 *  • modo cron: todas as VENCIDAS. O filtro `scheduled_for <= now()` é o que
 *    garante que os prazos prometidos (48h / 10 dias úteis) sejam respeitados —
 *    a fila nem enxerga uma solicitação antes da data dela.
 */
async function selectDeletionQueue(
  admin: SupabaseClient,
  requestId: string | null,
): Promise<{ due: DeletionRequest[] } | { refusal: Response }> {
  if (!requestId) {
    const { data, error } = await admin
      .from('account_deletion_requests')
      .select(SELECT_COLUMNS)
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(MAX_PER_RUN);
    if (error) throw error;
    return { due: (data ?? []) as DeletionRequest[] };
  }

  const { data, error } = await admin
    .from('account_deletion_requests')
    .select(SELECT_COLUMNS)
    .eq('id', requestId)
    .in('status', ['pending', 'failed'])
    .limit(1);
  if (error) throw error;

  const due = (data ?? []) as DeletionRequest[];
  if (due.length === 0) {
    return { refusal: json({ error: 'solicitação não encontrada ou já resolvida' }, 404) };
  }
  if (due[0].export_requested && due[0].export_status !== 'delivered') {
    return {
      refusal: json(
        {
          error:
            'A exportação ainda não foi confirmada como entregue. Marque a entrega antes de excluir.',
        },
        409,
      ),
    };
  }
  return { due };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return textResponse('method not allowed', 405);

  const auth = await authorize(req);
  if (!auth.ok) return auth.response;

  const admin = adminClient();

  try {
    const selecionadas = await selectDeletionQueue(admin, auth.requestId);
    if ('refusal' in selecionadas) return selecionadas.refusal;
    const due = selecionadas.due;

    const results: Record<string, string> = {};
    for (const r of due) {
      // Uma solicitação com erro NÃO pode derrubar as outras da rodada.
      try {
        results[r.id] = await processOne(admin, r);
      } catch (e) {
        results[r.id] = 'error';
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[process-deletion-requests] solicitação ${r.id} falhou`, e);
        await admin
          .from('account_deletion_requests')
          .update({
            last_error: message.slice(0, 500),
            export_status: r.export_requested ? 'failed' : r.export_status,
            updated_at: new Date().toISOString(),
          })
          .eq('id', r.id);
      }
    }

    // As filas 2 e 3 só rodam no modo cron: o modo painel existe para executar
    // UMA exclusão específica.
    const exports = auth.requestId ? {} : await processExportQueue(admin);
    const orphans = auth.requestId ? {} : await processOrphanQueue(admin);
    const cleaned = auth.requestId ? 0 : await cleanupOldDeletionExports(admin);

    return json({
      processed: due.length,
      results,
      exportRequests: exports,
      orphanAccounts: orphans,
      cleanedExports: cleaned,
    });
  } catch (e) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[process-deletion-requests ${ref}]`, e);
    return json({ error: 'Falha ao processar as solicitações.', ref }, 500);
  }
});
