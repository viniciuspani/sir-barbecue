# Plano — Sir Barbecue Web (PWA mobile-first como app de iOS)

## Contexto

O Sir Barbecue é um PDV mobile (Expo/React Native, offline-first com SQLite + sync com Supabase multi-tenant), pronto para Android. Publicar na App Store custa caro (US$ 99/ano + processo de revisão), e esse custo não se justifica neste momento.

**Objetivo:** construir um app **web PWA instalável**, com todas as funcionalidades do mobile e **telas adaptadas para celular**, para que o cliente de iPhone instale pela Safari ("Adicionar à Tela de Início") e opere como se fosse um app nativo. O Android continua no app nativo atual, que fica **preservado e pronto para publicar**.

Consequência disso: o PWA é **mobile-first**, não um painel de desktop. Ele espelha as telas do app (abas inferiores, cartões, alvos de toque grandes) e apenas se expande em telas maiores — o balcão com notebook ganha isso de brinde, mas não é o alvo.

### Decisões tomadas

| Decisão | Escolha |
|---|---|
| Stack web | **React 19 + Vite** (mesma do painel admin em `c:\develop\WEB\sir-barbecue-admin`) |
| Repositório | **Separado**: `c:\develop\WEB\sir-barbecue-web` — sem monorepo, mobile intocado estruturalmente |
| Forma | **PWA instalável, mobile-first**, focado em iOS/Safari |
| Offline | **Online-only na v1** + shell cacheado; fila de vendas offline planejada para depois |
| Comandas | **Sincronizadas no servidor** — inclui alteração no mobile e novo APK |

---

## Arquitetura

```
c:\develop\WEB\sir-barbecue-web\      (repo NOVO, independente)
├── src/
│   ├── core/            portado do mobile — TypeScript puro, sem expo/react-native
│   │   ├── domain/      entities + tipos (de src/domain/entities)
│   │   ├── rules/       permissions, access, membership, tenant, currency, dates, errors
│   │   └── content/     help/topics.ts
│   ├── data/            cliente Supabase + repositórios sobre PostgREST/RPC
│   ├── ui/              design system web (tokens do mobile como CSS vars)
│   ├── screens/         telas mobile-first
│   └── pwa/             manifest, service worker, telas de instalação iOS
└── public/icons/        ícones PWA + apple-touch-icon + splash screens iOS
```

**Stack:** React 19, Vite, TypeScript, Tailwind 4, react-router-dom 7, TanStack Query 5, Zustand, Recharts, lucide-react, `@supabase/supabase-js`, `vite-plugin-pwa`, `@sentry/react`, Vitest.

**Dados:** sem motor de sync. Leitura/escrita direta no Supabase (PostgREST + RPC) via TanStack Query, com invalidação por Supabase Realtime nas tabelas do tenant. As mesmas RLS e os mesmos papéis do mobile valem aqui.

### Código compartilhado com o mobile (sem monorepo)

Como os repositórios são separados, o `src/core/` do web é um **porte manual** da camada pura do mobile. Para o custo disso não virar bug de segurança:

1. `src/core/PARIDADE.md` mapeia arquivo-a-arquivo a origem no repo mobile (ex.: `core/rules/permissions.ts` ← `src/lib/permissions.ts`) e marca cada um como *espelho* (não editar isoladamente) ou *específico do web*.
2. **Testes Vitest fixam as regras críticas** — matriz RBAC completa (owner/manager/employee × cada `canAccess*`/`canWrite*`) e os veredictos de `AccessReason`. Se o mobile mudar uma regra e o web não, o teste continua verde mas o `PARIDADE.md` aponta o par a revisar; qualquer mudança de RBAC exige rodar o checklist nos dois lados.
3. O que **não** é portado: `secureStorage`, `netinfo`, `errorLog` (fila local), `syncEngine`, tudo de `expo-*`. O web tem equivalentes próprios (`localStorage`, `navigator.onLine`, `crypto.randomUUID`, envio direto de erro).

---

## Design mobile-first (iOS)

- **Navegação:** barra de abas inferior espelhando o app — Início, Venda, Produtos, Estoque, Mais. Acima de 1024px vira sidebar (progressive enhancement, sem tela dedicada).
- **Identidade:** os tokens de `src/design/tokens.ts` / `typography.ts` viram CSS variables (tema escuro + dourado `#D4A017`), fonte Inter, `BrandLogo` reaproveitado.
- **Regras específicas de iOS/Safari, tratadas desde o início:**
  - `viewport-fit=cover` + `env(safe-area-inset-*)` — notch e barra inferior do iPhone;
  - inputs com `font-size: 16px` (abaixo disso o iOS dá zoom automático ao focar);
  - `manifest.json` com `display: standalone`, `apple-touch-icon` 180×180 e splash screens iOS;
  - iOS **não dispara** `beforeinstallprompt`: é preciso uma tela/banner ensinando "Compartilhar → Adicionar à Tela de Início" (detectando Safari iOS fora do modo standalone);
  - dentro do PWA instalado não há botão de voltar do navegador — cada tela precisa do próprio voltar;
  - links externos (relatório em signed URL) abrem no Safari, saindo do app — usar `<iframe>` interno em vez de link direto sempre que possível.

---

## Mapa de paridade (mobile → PWA)

| Mobile | PWA (rota) |
|---|---|
| `app/(auth)/login\|signup\|forgot-password\|verify-email` | `/login`, `/cadastro`, `/recuperar-senha`, `/verificar-email` |
| `app/reset-password.tsx`, `app/auth-callback.tsx` | `/redefinir-senha`, `/auth/callback` (`detectSessionInUrl: true`) |
| `app/(app)/index.tsx` | `/` — KPIs do dia, alerta de estoque baixo, nudge de onboarding |
| `app/(app)/venda/index.tsx` + `fechar.tsx` | `/venda` — mesmo fluxo: catálogo → carrinho → pagamento/consumo |
| comandas (dentro de `venda`) | `/comandas` — agora no servidor |
| `app/(app)/produtos/index\|form` | `/produtos`, `/produtos/novo\|:id` |
| `app/(app)/estoque/index\|detalhe\|entrada\|historico-preco` | `/estoque/...` |
| `app/(app)/mais/fornecedores\|fornecedor-form\|fornecedor-detalhe` | `/fornecedores/...` |
| `app/(app)/mais/relatorios.tsx` | `/relatorios` — WebView → `<iframe>` com signed URL |
| `app/(app)/mais/empresa.tsx` | `/empresa` — dados, equipe, convite (`invite-member`) |
| `app/(app)/mais/perfil.tsx` | `/conta` — perfil, sair, excluir conta (`delete-account`) |
| `app/(app)/mais/ajuda*.tsx` | `/ajuda` — conteúdo de `content/help/topics.ts` |
| `app/boas-vindas.tsx` | `/boas-vindas` |
| `AccessBlocked`, `MembershipRequired`, `OfflineBanner` | guardas: sessão → vínculo → licença → papel |
| Notificações push | — (já desabilitado no mobile; iOS PWA só suporta a partir do 16.4) |

---

## Fases

### F0 — Repo web e porte do core *(não toca no mobile)*
1. Criar `c:\develop\WEB\sir-barbecue-web` (git init, Vite + React + TS + Tailwind 4), espelhando as convenções do `sir-barbecue-admin`.
2. Portar para `src/core/`: `src/domain/entities`, `src/lib/{currency,dates,errors,permissions,a11y}.ts`, `src/services/{tenant,membership,access,onboarding,tenantBranding}.ts` e `src/content/help/topics.ts` — removendo imports de `expo-*`/`react-native` e trocando `secureStorage` por `localStorage`.
   - `usePermissions` (hoje acoplado ao `useAuthStore`) vira função pura no core + hook no web.
   - `access.ts` no web dispensa o cache de 72h offline: consulta `get_access_status` e trata falha de rede como "não verificado".
3. Escrever `src/core/PARIDADE.md` e os testes Vitest da matriz RBAC e dos veredictos de acesso.
4. Cliente Supabase web: `storage: localStorage`, `detectSessionInUrl: true`, `flowType: 'pkce'`.

### F1 — Shell mobile-first + autenticação
- Design system web a partir dos tokens; componentes base (Button, TextField, MoneyField, Chip) equivalentes aos de `src/ui/`.
- Layout com tab bar inferior, safe-areas, cabeçalho com empresa/papel/status de conexão.
- Login, cadastro, recuperação e redefinição de senha, verificação de e-mail, callback.
- Guardas em camadas: sessão → `resolveMembership` → `get_access_status` → papel, com as telas de bloqueio equivalentes.

### F2 — Catálogo
- **Produtos:** lista com busca e filtro por categoria, form (nome, preço, categoria, dias visíveis, ativo).
- **Fornecedores:** lista, form, detalhe, vínculo produto↔fornecedor (preço de compra, preferencial, inativar) e histórico de custo.
- Escrita respeitando `canWriteCatalog` / `canWriteSuppliers` — UI esconde, RLS barra.

### F3 — Estoque
- Lista com destaque abaixo do `alert_threshold`, detalhe do item, entrada de estoque, histórico de preço de compra.

### F4 — Venda (PDV)
- Fluxo idêntico ao do app: catálogo → carrinho → forma de pagamento e modo de consumo → fechar; botão Fechar verde e Cancelar vermelho com confirmação, como no mobile.
- **Criar RPC transacional `create_sale`** no Postgres, gravando `sales` + `sale_items` e baixando `stock_items` numa única transação. Sem isso, o web repetiria o problema de oversell/inconsistência já resolvido no mobile.
- Alerta de estoque e bloqueio de oversell usando as regras do core.

### F5 — Comandas no servidor *(inclui alteração no mobile)*
- **F5a (backend + web):** migração `MIGRATION_09_tabs.sql` criando `public.tabs` e `public.tab_items` no padrão das demais tabelas (`tenant_id`, `client_id unique`, RLS `tenant_all`, realtime), com `status` (`open`/`closed`) e ligação com `sales.client_id` no fechamento; tela `/comandas` no web.
- **F5b (mobile):** `tabs`/`tab_items` locais ganham `tenant_id` e `needs_sync`; push/pull incluídos em `src/data/sync/syncEngine.ts`; o primeiro sync **sobe** as comandas já abertas nos aparelhos (não apaga). Gera novo APK.

### F6 — Início, Relatórios, Empresa, Conta e Ajuda
- Início com KPIs do dia e alerta de estoque baixo (Recharts).
- Relatórios: `generate-report` → signed URL em `<iframe>`, com opção de abrir/baixar.
- Empresa (dados, equipe, convite por papel), Conta (perfil, sair, excluir conta), Ajuda, Boas-vindas.

### F7 — PWA, iOS e publicação
- `vite-plugin-pwa`: manifest, ícones, apple-touch-icon, splash screens, service worker cacheando o shell (abre sem rede, mostra estado offline claro).
- Tela de instalação para iOS (Safari fora do modo standalone).
- Domínio + deploy (Netlify, como o painel admin) com HTTPS.
- `supabase secrets set ALLOWED_ORIGIN="https://<dominio-web>,https://sir-barbecue-admin.netlify.app,http://localhost:5173"` — hoje as functions negam origem de navegador por padrão; sem isso `generate-report`, `invite-member` e `delete-account` quebram em produção.
- Redirect URLs do web no Supabase Auth (callback e reset de senha).
- Sentry (`@sentry/react`) e gravação de erro em `error_logs` com o mesmo código de referência mostrado ao usuário.

### F8 — *(depois da v1)* Fila de vendas offline
- IndexedDB guardando vendas/comandas feitas sem rede e enviando ao reconectar, aproximando o PWA do comportamento offline-first do Android.

---

## Arquivos e recursos críticos

- **Origem do porte (leitura no repo mobile):** [src/domain/](../../src/domain/), [src/lib/permissions.ts](../../src/lib/permissions.ts), [src/services/access.ts](../../src/services/access.ts), [src/services/membership.ts](../../src/services/membership.ts), [src/services/tenant.ts](../../src/services/tenant.ts), [src/design/tokens.ts](../../src/design/tokens.ts), [src/content/help/topics.ts](../../src/content/help/topics.ts), [src/ui/](../../src/ui/)
- **Referência de fluxo de tela:** [app/(app)/venda/index.tsx](../../app/(app)/venda/index.tsx), [app/(app)/venda/fechar.tsx](../../app/(app)/venda/fechar.tsx), [app/(app)/index.tsx](../../app/(app)/index.tsx), [app/(app)/mais/relatorios.tsx](../../app/(app)/mais/relatorios.tsx)
- **Únicos arquivos do mobile alterados (F5b):** [src/data/repositories/TabRepository.ts](../../src/data/repositories/TabRepository.ts), [src/data/sync/syncEngine.ts](../../src/data/sync/syncEngine.ts), [src/data/local/database.ts](../../src/data/local/database.ts), [src/data/local/schema.ts](../../src/data/local/schema.ts)
- **Backend:** `docs/banco-multi-cliente/SUPABASE_SCHEMA_SAAS_MULTI_TENANT.sql` (padrão a seguir), `MIGRATION_08_create_sale.sql` (F4, criada) e `MIGRATION_09_tabs.sql` (F5), nova RPC `create_sale`, `supabase/functions/{generate-report,invite-member,delete-account}/index.ts` (CORS)
- **Referência de stack e deploy:** `c:\develop\WEB\sir-barbecue-admin`

---

## Verificação

**A cada fase:** `npm run dev` e comparação lado a lado com a tela mobile equivalente, na mesma empresa e com os mesmos dados. `npx vitest run` para a matriz RBAC. Validação com as três contas (owner, manager, employee): tela escondida **e** escrita negada pela RLS — não basta a UI esconder. Empresa com licença expirada deve cair na tela de bloqueio.

**Teste em iPhone real (obrigatório a partir de F1, repetido em F7):**
- abrir no Safari, instalar na Tela de Início e operar **em modo standalone** — é onde aparecem os problemas (safe-area, zoom de input, falta de botão voltar, sessão perdida);
- vender do início ao fim pelo iPhone instalado e conferir a venda no app Android;
- deixar o PWA parado alguns dias e reabrir: confirmar se a sessão sobrevive (ITP do Safari pode limpar dados de site) e se a re-autenticação é indolor.

**Cross-device (F5):** abrir comanda no Android, ver aparecer no iPhone em até um ciclo de sync; fechar no iPhone e conferir baixa de estoque, sem duplicidade.

**Regressão do mobile (F5b):** `npm run typecheck`, `npm run lint`, teste manual de venda/comanda/sync e `eas build --profile preview --platform android` concluindo.

**Fim (F7):** build de produção no domínio publicado, PWA instalável no iPhone, `generate-report` e `invite-member` funcionando (CORS), erro forçado aparecendo em `error_logs` no painel admin.

---

## Riscos e fora de escopo

- **Fora:** notificações push, publicação na App Store, mudanças no painel admin do dono.
- **Risco 1 — divergência de regra entre os dois repos.** RBAC e regras de assinatura passam a existir em duas cópias. Mitigação: `PARIDADE.md` + testes Vitest + revisar os dois lados sempre que uma regra mudar.
- **Risco 2 — iPhone sem internet não vende na v1.** É a diferença real de comportamento entre Android (offline-first) e iOS (PWA online-only). Precisa ser dito ao cliente; F8 endereça.
- **Risco 3 — Safari apagar os dados do site** após período de inatividade, derrubando a sessão. Mitigação: manter o refresh token do Supabase, tornar o relogin rápido e não guardar nada crítico só no navegador.
- **Risco 4 — F5b mexe em dado de produção:** comandas locais já abertas nos aparelhos precisam subir no primeiro sync, não ser descartadas.
- **Esforço aproximado:** F0 ~2 dias · F1 ~3 dias · F2 ~3 dias · F3 ~2 dias · F4 ~3–4 dias · F5 ~3–4 dias · F6 ~3 dias · F7 ~2–3 dias.
