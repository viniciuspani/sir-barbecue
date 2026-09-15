# Exportação de dados da empresa (LGPD/portabilidade)

## Contexto

Hoje, se uma empresa quiser seus próprios dados fora do app, o único mecanismo é o relatório HTML de vendas (`generate-report`) — que é uma agregação (KPIs + gráficos), não um dump dos dados brutos. Não existe forma de baixar vendas, estoque, fornecedores, custo ou o histórico de pagamento da assinatura em formato reutilizável (planilha, importação em outro sistema, contador). Isso veio à tona na auditoria de segurança: a decisão de manter a LEITURA aberta mesmo pra empresa inadimplente (MIGRATION_11, achado A06-01) foi justificada por "o cliente inadimplente precisa conseguir consultar e exportar os próprios dados (LGPD e suporte)" — mas essa exportação, hoje, não existe de fato como funcionalidade. Este plano fecha essa lacuna: um botão "Exportar dados", só pro **owner**, que gera um `.zip` com um `.csv` por entidade (vendas, estoque, fornecedores, pagamentos, relatórios já gerados) e entrega pro download, no app mobile e no PWA web.

Decisões já validadas com o usuário: formato **CSV por entidade dentro de um ZIP**; disponível nos **dois** apps (mobile e web); "pagamentos" inclui **tanto** a forma de pagamento das vendas **quanto** o histórico de cobrança da assinatura SaaS.

## O que muda no banco (nova migration, `docs/banco-multi-cliente/MIGRATION_22_export_infra.sql`)

1. **Tabela `data_exports`** — mesmo espírito de `reports` (schema.sql:272-286), mas em tabela própria (não reaproveitar `reports`: seu `type` tem `CHECK` fechado em 4 valores de relatório analítico, e semanticamente é outra coisa — dump bruto vs. relatório agregado):
   ```
   id, tenant_id (FK tenants), client_id (unique), requested_by (uuid, sem FK — mesmo raciocínio da MIGRATION_20/21),
   status ('pending'|'ready'|'failed'), parameters jsonb, zip_url text, error_message text,
   created_at, completed_at
   ```
   RLS: **owner-only** (mais restrito que `reports`, que é owner|manager — aqui tem custo de fornecedor e cobrança de assinatura, dado mais sensível):
   ```sql
   create policy data_exports_owner_access on public.data_exports for all to authenticated
     using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));
   ```

2. **Bucket novo `exports`** (privado, mesmo padrão de `reports` — schema.sql:679-688) + policy própria (owner-only, não owner|manager):
   ```sql
   insert into storage.buckets (id, name, public) values ('exports','exports', false) on conflict (id) do nothing;

   create policy exports_tenant_owner_read on storage.objects for select to authenticated
     using (bucket_id = 'exports' and public.is_tenant_owner(((storage.foldername(name))[1])::uuid));
   ```
   Upload só pela Edge Function via `service_role` (igual `generate-report`) — sem policy de INSERT pro cliente.

3. **Nova policy de leitura em `payments`** (histórico de cobrança da assinatura). Hoje só existe `payments_admin_all` (LICENSING.sql:201-203) — um owner comum lê **zero linhas**. Adicionar, sem remover a existente (policies permissivas se somam com OR, mesmo padrão da MIGRATION_11):
   ```sql
   create policy payments_tenant_owner_read on public.payments for select to authenticated
     using (tenant_id in (select public.user_tenant_ids()) and public.is_tenant_owner(tenant_id));
   ```

**Teste funcional da migration** (SQL Editor, com token de um owner real — mesmo método usado agora pra provar a MIGRATION_11): confirmar que `select * from public.payments` retorna as linhas do próprio tenant pra um owner e continua vazio pra um employee.

## Nova Edge Function — `supabase/functions/export-company-data/index.ts`

Self-contained, seguindo exatamente o esqueleto de `generate-report/index.ts` (CORS via `ALLOWED_ORIGIN`, `adminClient()`/`userClient()`, `resolveCaller` com validação de `tenant_id` via `user_tenant_ids()`, erro genérico + `ref` de 8 caracteres — A10-01):

1. **Autorização: só `owner`** (mais estrito que `generate-report`, que aceita manager). Query em `tenant_members` igual ao padrão já usado.
2. **Parâmetros opcionais** `{ from?, to? }` — mesma validação de intervalo de `generate-report` (máx. 1 ano), mas **sem período por padrão** = exporta o histórico inteiro (é dado de portabilidade, não um relatório de período).
3. **Coleta os dados** com o cliente do usuário (`userClient(req)`, não `service_role`) — a RLS já isola por tenant e decide o que o owner pode ler; é o mesmo raciocínio de segurança do `generate-report` (a autorização vem da própria RLS, não de uma lista hardcoded de tabelas).
4. **Monta um `.csv` por entidade** com um helper local `toCsv(rows, columns)` (escrito à mão — sem lib nova pra isso, é serialização simples com aspas RFC4180). Arquivos do zip:

   | Arquivo | Origem | Observação |
   |---|---|---|
   | `vendas.csv` | `sales` | inclui `payment_method` (cobre "forma de pagamento") |
   | `itens_venda.csv` | `sale_items` | `product_name` resolvido via join com `products` (senão só teria UUID) |
   | `comandas.csv` | `tabs` | |
   | `itens_comanda.csv` | `tab_items` | já tem `name`/`unit_price` congelados na própria linha |
   | `estoque_atual.csv` | `stock_items` | `product_name` resolvido |
   | `movimentacoes_estoque.csv` | `stock_entries` | `product_name`/`supplier_name` resolvidos |
   | `fornecedores.csv` | `suppliers` | |
   | `produtos_fornecedores.csv` | `product_suppliers` | `product_name`/`supplier_name` resolvidos |
   | `historico_precos_fornecedor.csv` | `product_supplier_price_history` | idem |
   | `produtos.csv` | `products` | `category_name` resolvido |
   | `categorias.csv` | `categories` | |
   | `pagamentos_assinatura.csv` | `payments` | histórico de cobrança SaaS (via a nova policy) |
   | `relatorios/<id>.html` + `relatorios.csv` | bucket `reports` + tabela `reports` | copia os HTMLs já gerados (lista via `admin.storage.from('reports').list(tenantId)`, baixa e reempacota) + um índice (tipo/período/data) |

   Isso cobre os 5 domínios pedidos (vendas, estoque, pagamentos, fornecedores, relatórios) mais `produtos`/`categorias` como apoio (sem eles, as outras planilhas só teriam UUID de produto).

5. **Zipa tudo** — usar `npm:jszip@3.10.1` (Supabase Edge Functions rodam em Deno com suporte a especificador `npm:`, mais confiável que `esm.sh` pra uma lib com dependências internas como o `jszip`). **Ponto a validar na implementação**: fazer um smoke test isolado do import antes de escrever o resto — se `npm:jszip` não funcionar bem no runtime do Supabase, cair para `esm.sh/jszip` como plano B.
6. **Grava a linha em `data_exports` ANTES do upload** (mesma ordem de segurança corrigida em `generate-report` — o INSERT passa pela RLS e é a barreira de autorização real; se der erro no upload depois, apaga a linha).
7. Upload em `exports/<tenant_id>/<export_id>.zip` via `admin.storage` (service_role).
8. Retorna `{ exportId, path }`.

**Limite conhecido, aceitável no tamanho atual do projeto**: tudo roda dentro de uma única invocação da function (sem fila/job em background) — mesmo modelo do `generate-report`. O próprio schema já assume escala de Supabase free tier (~500MB), então isso não deve estourar o tempo de execução da function. Se um dia um tenant ficar grande demais, aí sim vale um redesenho assíncrono — não antes.

## App mobile (`c:\develop\MOBILE\sir-barbecue`)

- **`src/services/functions.ts`**: novas `exportCompanyData(input)` e `getExportSignedUrl(path)`, espelhando exatamente `generateReport`/`getReportSignedUrl` (linhas 75-88 do arquivo), mas contra o bucket `exports`.
- **`src/lib/permissions.ts`**: novo `canAccessExport = isOwner` (é o primeiro gate estritamente owner-only da tela — hoje o mais restrito existente é `isManagerUp`). Adicionar ao `Permissions` e ao retorno de `usePermissions()`.
- **Nova tela `app/(app)/mais/exportar-dados.tsx`**: mesmo esqueleto de `relatorios.tsx` (gate `canAccessExport` com `Redirect`, estado `generating`, botão com `loading`), mas em vez de `fetch→setHtml→Modal/WebView`, faz:
  ```ts
  const { path, error } = await exportCompanyData({});
  const url = await getExportSignedUrl(path);
  const { uri } = await FileSystem.downloadAsync(url, FileSystem.cacheDirectory + 'sir-barbecue-dados.zip');
  await Sharing.shareAsync(uri);
  ```
  `expo-file-system` e `expo-sharing` **já estão instalados** (`package.json`, `expo-sharing` já registrado em `app.json:36`) mas nunca foram usados em nenhum lugar do código — esta é a primeira vez que entram em uso, não precisa adicionar dependência nova.
- **Hub `app/(app)/mais/index.tsx`**: novo item em `ITEMS` (`icon: 'download-outline'`, `label: 'Exportar dados'`, `route: '/mais/exportar-dados'`, `requires: 'export'`), e estender o union `Perm` com `'export'`.
- **`app/(app)/mais/_layout.tsx`**: registrar `<Stack.Screen name="exportar-dados" options={{ title: 'Exportar dados' }} />`.

## App web/PWA (`c:\develop\WEB\sir-barbecue-web`, repo separado)

- **`src/data/services/functions.ts`**: mesmas duas funções, espelhando `generateReport`/`getReportSignedUrl` (linhas 81-94).
- **`src/core/rules/permissions.ts`**: `canAccessExport = isOwner`, incluído em `permissionsFor()` e no tipo `Permissions`.
- **Nova tela** (ex. `src/screens/exportar-dados/ExportarDados.tsx`), mesmo padrão de gate de `Relatorios.tsx` (`if (!canAccessExport) return <Navigate to="/mais" replace />`). Como não existe NENHUM padrão de download binário no repo web hoje (confirmado — sem `<a download>`, sem `file-saver`, sem lib de blob), a lógica de download é:
  ```ts
  const res = await fetch(signedUrl);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl; a.download = 'sir-barbecue-dados.zip'; a.click();
  URL.revokeObjectURL(objectUrl);
  ```
  (evita a limitação do atributo `download` em link cross-origin direto pra uma signed URL do Storage).
- **Navegação**: adicionar a entrada/rota equivalente ao hub "Mais" do mobile — o agente de exploração não chegou a mapear esse arquivo específico; localizar o equivalente (provavelmente ao lado de onde `Relatorios`/`Fornecedores` são registrados nas rotas) no início da implementação.

## Verificação de ponta a ponta

1. Rodar `MIGRATION_22` num ambiente de teste; conferir `data_exports`/bucket `exports`/policy de `payments` criados.
2. Repetir o teste de bypass que já fizemos nesta sessão: autenticar como owner via `curl`, chamar `POST .../functions/v1/export-company-data`, confirmar `200` + baixar o zip pela signed URL devolvida; autenticar como `employee`/`manager` do mesmo tenant e confirmar `403`.
3. Abrir o zip baixado e conferir: contagem de linhas de cada CSV bate com `select count(*) from <tabela> where tenant_id = '<id>'`; `pagamentos_assinatura.csv` não vem vazio (prova a policy nova); pasta `relatorios/` contém os HTMLs que já existiam pra esse tenant.
4. No app mobile, como owner: tocar "Exportar dados", confirmar que baixa e abre a folha de compartilhamento nativa; como employee, confirmar que o item nem aparece no hub Mais.
5. No PWA, como owner: clicar "Exportar dados", confirmar que o `.zip` baixa pelo navegador; como employee, confirmar que a tela/menu não aparece.
