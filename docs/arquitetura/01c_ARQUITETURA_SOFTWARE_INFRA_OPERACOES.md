# Arquitetura de Software — Sir Barbecue

> **Fase:** 3 de 3 — Autenticação, Cache, Offline, Observabilidade, Deploy, Stack e Riscos
> **Versão:** 1.1 (revisada para Expo SDK 55 em 19/06/2026 — ver [ANALISE_IMPACTO_EXPO_SDK_55.html](../plano/ANALISE_IMPACTO_EXPO_SDK_55.html))
> **Data:** 07/06/2026
> **Elaborado por:** Arquiteto de Soluções (gerado via /arquiteto-solucoes-sistema)
> **Baseado em:** Designing Data-Intensive Applications — Martin Kleppmann
> **Documento anterior:** [01b_ARQUITETURA_SOFTWARE_COMPONENTES_API.md](./01b_ARQUITETURA_SOFTWARE_COMPONENTES_API.md)
> **Próximo documento:** [02a_ARQUITETURA_BD_MODELO_DADOS.md](./02a_ARQUITETURA_BD_MODELO_DADOS.md)
>
> **Revisão 19/06/2026 — Expo SDK 55:** stack, CI/EAS e riscos atualizados (RN 0.83.1; Xcode 26 / Node 20+; `eas update --environment`; `@sentry/react-native` ≥ 7.3.0). Base: [ANALISE_IMPACTO_EXPO_SDK_55.html](../plano/ANALISE_IMPACTO_EXPO_SDK_55.html).

---

## Índice desta Fase

8. [Autenticação e Autorização](#8-autenticação-e-autorização)
9. [Estratégia de Cache](#9-estratégia-de-cache)
10. [Suporte Offline — Detalhamento](#10-suporte-offline--detalhamento)
11. [Processamento de Relatórios](#11-processamento-de-relatórios)
12. [Observabilidade](#12-observabilidade)
13. [Deployment e Infraestrutura](#13-deployment-e-infraestrutura)
14. [Escalabilidade e Resiliência](#14-escalabilidade-e-resiliência)
15. [Stack Tecnológico Recomendado](#15-stack-tecnológico-recomendado)
16. [Riscos e Trade-offs](#16-riscos-e-trade-offs)

---

## 8. Autenticação e Autorização

### 8.1 Estratégia de Autenticação

**Mecanismo:** Supabase Auth — JWT + OAuth 2.0 (Google)

**Fluxo de autenticação por email/senha:**
```
1. Usuário: POST /auth/v1/token (email + password)
2. Supabase: valida credenciais → gera access_token (JWT, 1h) + refresh_token (30d)
3. App: armazena tokens no Keychain (iOS) / Keystore (Android) via Expo SecureStore
4. Requisições: Authorization: Bearer <access_token>
5. Expiração: SDK renova automaticamente via refresh_token antes de expirar
```

**Fluxo de autenticação Google OAuth:**
```
1. Usuário: toca "Entrar com Google"
2. App: abre Google OAuth via Expo AuthSession (PKCE flow)
3. Google: retorna authorization code
4. App: envia code para Supabase Auth
5. Supabase: valida com Google → cria/recupera usuário → retorna JWT
6. Na primeira vez: conta criada automaticamente (RF-02)
```

**Estrutura do JWT (Supabase):**
```json
{
  "sub": "user-uuid",
  "email": "proprietaria@email.com",
  "role": "authenticated",
  "iat": 1749340800,
  "exp": 1749344400
}
```

### 8.2 Controle de Acesso (Autorização)

**Modelo:** Proprietário único em v1 — todos os dados pertencem ao usuário autenticado.

**Mecanismo:** Row Level Security (RLS) no PostgreSQL:

```sql
-- Todas as tabelas têm RLS habilitado
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Política: usuário só acessa seus próprios dados
CREATE POLICY "owner_only" ON products
  USING (user_id = auth.uid());
```

**Implicação:** Não há perfis ou papéis adicionais em v1. Se v2 introduzir funcionários, o modelo RBAC será adicionado sem refatoração do frontend (RLS absorve a mudança).

### 8.3 Segurança de Tokens no Dispositivo

| Plataforma | Mecanismo de Armazenamento | API Utilizada |
|-----------|---------------------------|---------------|
| iOS | Keychain Services | `expo-secure-store` |
| Android | Android Keystore / EncryptedSharedPreferences | `expo-secure-store` |

**Dados financeiros locais (WatermelonDB):** o SQLite local é armazenado no sandbox privado do app — não é acessível a outros apps. Não é necessária criptografia adicional para v1, mas pode ser habilitada com SQLCipher se exigido por revisão de segurança futura (RNF-07).

**Sessão:** expira após 1h de access_token; refresh_token renova silenciosamente. Inatividade prolongada (30d) força novo login.

---

## 9. Estratégia de Cache

> **Referência DDIA:** Cap. 5 — leitura de réplicas como cache; Cap. 1 — latência vs throughput.

### 9.1 Camadas de Cache

| Camada | Tecnologia | TTL | O que cachear |
|--------|-----------|-----|---------------|
| Local SQLite (WatermelonDB) | SQLite no dispositivo | Permanente (até sync) | Todos os dados operacionais — catálogo, estoque, vendas, fornecedores |
| Zustand in-memory | Memória do processo | Duração da sessão | Auth state, connectivity state, sync status, configurações de UI |
| Dashboard data | WatermelonDB + timestamp | 5 minutos (RF-28) | Aggregates do dashboard — total do mês, ticket médio |
| Relatórios gerados | Supabase Storage | Permanente | PDFs e HTMLs já gerados (não regenerar desnecessariamente) |

### 9.2 Estratégia por Tipo de Dado

**Dados de catálogo (produtos, categorias, fornecedores):**
- Estratégia: Write-through — ao criar/editar, escrita simultânea no WatermelonDB local e, quando online, no Supabase
- Invalidação: mudanças remotas propagadas via Realtime

**Dados de vendas:**
- Estratégia: Write-local-first — venda gravada localmente primeiro; sync com servidor em background
- Nunca descartada sem confirmação de sync bem-sucedido

**Dashboard (RF-27, RF-28):**
- Estratégia: Cache-Aside com TTL de 5 minutos
- Na abertura do app: exibe dados do cache local com timestamp da última atualização
- Atualização automática a cada 5 minutos enquanto app está em foreground

**Relatórios gerados:**
- Uma vez gerado e armazenado no Storage, o arquivo não é regerado
- O app guarda a URL localmente (WatermelonDB) para evitar re-download desnecessário

---

## 10. Suporte Offline — Detalhamento

> **Referência DDIA:** Cap. 5 (Replicação) e Cap. 9 (Consistência) — o modelo offline-first é essencialmente um sistema de replicação com single-leader (servidor) e um follower stateful (dispositivo).

### 10.1 Modelo de Dados Dual (Local + Remoto)

```
DISPOSITIVO (WatermelonDB)          SERVIDOR (Supabase PostgreSQL)
─────────────────────                ─────────────────────────────
products           ←──── sync ────→  products
categories         ←──── sync ────→  categories
suppliers          ←──── sync ────→  suppliers
product_suppliers  ←──── sync ────→  product_suppliers
stock_items        ←──── sync ────→  stock_items
stock_entries      ←──── sync ────→  stock_entries
sales              ──── write ────→  sales
sale_items         ──── write ────→  sale_items
product_visibility ←──── sync ────→  product_day_visibility
reports            ←──── read ────→  reports (apenas metadados/status)
```

### 10.2 Campos de Controle de Sync (WatermelonDB)

Todos os modelos locais incluem campos de controle:

```typescript
// Campos adicionados a todos os modelos WatermelonDB
client_id: string        // UUID gerado no cliente — chave de idempotência
needs_sync: boolean      // true = há alteração local não sincronizada
last_synced_at: Date     // timestamp do último sync bem-sucedido
server_id: string        // ID no servidor após sync (pode diferir do client_id)
```

### 10.3 Resolução de Conflitos por Entidade

| Entidade | Conflito Possível | Estratégia | Justificativa |
|----------|------------------|------------|---------------|
| Vendas | Venda offline com produto editado online | Client wins — venda mantém preço local | O preço no momento da venda é o correto |
| Estoque | Saldo ajustado offline + online simultaneamente | Server wins + compensação | Raro; servidor recalcula saldo correto no próximo sync |
| Produtos | Preço editado no servidor enquanto offline | Server wins | Catálogo é gerenciado online; mudança offline é exceção |
| Configurações de visibilidade | Edição offline + online | Last-writer-wins com timestamp | Baixo impacto; timestamp suficiente |

### 10.4 Indicadores Visuais de Conectividade

| Estado | Indicação Visual |
|--------|----------------|
| Online + sincronizado | Nenhum indicador (estado normal) |
| Online + sync em andamento | Ícone de sincronização animado (barra superior) |
| Offline | Banner fixo vermelho/amarelo: "Modo offline — vendas salvas localmente" |
| Sync concluído | Toast de confirmação: "Dados sincronizados ✓" |
| Erro de sync | Toast de erro com opção de tentar novamente |

---

## 11. Processamento de Relatórios

> **Referência DDIA:** Cap. 10 (Batch Processing) — geração de relatórios é batch job: lê dados históricos, processa, produz saída.

### 11.1 Fluxo de Geração de Relatório

**Trigger:** Usuário solicita relatório no app → POST `/functions/v1/generate-report`

**Processamento no Edge Function (Deno + TypeScript):**
1. Recebe parâmetros (tipo, período, user_id)
2. Query no PostgreSQL: JOIN sales + sale_items + products + product_suppliers (para custo)
3. Calcula agregações: total por pagamento, ticket médio, margem por produto
4. Renderiza template HTML com gráficos (Chart.js via headless browser ou biblioteca de charts para Deno)
5. Converte HTML para PDF (Puppeteer headless Chrome no Edge Function)
6. Upload do PDF e HTML para Supabase Storage
7. UPDATE na tabela `reports`: status = 'ready', urls dos arquivos
8. Envia push notification via Expo Push API

**Status do relatório:**
```
pending → processing → ready
                    ↘ failed (em caso de erro — com mensagem)
```

### 11.2 Jobs de Relatório

| Relatório | Tipo de Query | Complexidade | Tempo Estimado |
|-----------|--------------|-------------|----------------|
| Diário de vendas (RF-17) | Simples (filtro por data + GROUP BY pagamento) | Baixa | < 5s |
| Mensal de vendas (RF-18) | Simples (filtro por mês + GROUP BY pagamento) | Baixa | < 5s |
| Produtos vendidos (RF-19) | JOIN com custo de fornecedor + cálculo de margem | Média | < 15s |
| Financeiro gerencial (RF-20) | JOIN complexo + ticket médio + margens totais | Alta | < 30s |

### 11.3 Gráficos nos Relatórios (RF-26)

| Dado | Tipo de Gráfico | Justificativa |
|------|----------------|---------------|
| Distribuição por forma de pagamento | Pizza | Proporção entre categorias |
| Vendas por dia do mês | Barras | Comparação temporal |
| Produto mais vendido | Barras horizontais | Ranking de volume |
| Margem de lucro por produto | Barras + linha de média | Comparação com benchmark |
| Evolução do faturamento | Linha | Tendência ao longo do tempo |

---

## 12. Observabilidade

### 12.1 Logs no App Mobile

**Estrutura:**
```typescript
// Log estruturado via console (capturado pelo Sentry em produção)
{
  level: 'info' | 'warn' | 'error',
  service: 'sync-engine' | 'auth' | 'sales' | 'reports',
  message: string,
  context: Record<string, unknown>,
  timestamp: ISO8601
}
```

**Ferramenta sugerida:** Sentry (React Native SDK) para captura de erros, crashes e performance traces em produção.

### 12.2 Logs no Supabase

- **PostgreSQL logs:** queries lentas (> 1s), erros de constraint, falhas de RLS
- **Edge Functions logs:** via Supabase Dashboard → Functions Logs
- **Auth logs:** tentativas de login, falhas, tokens expirados

### 12.3 Métricas Essenciais

| Métrica | Onde monitorar | Alerta |
|---------|---------------|--------|
| Falhas de autenticação | Supabase Auth Logs | > 3 falhas em 5 min |
| Erros de sync offline | Sentry (app) | Qualquer erro recorrente |
| Tempo de geração de relatório | Edge Function logs | > 60s |
| Falha de push notification | Expo Push API response | Qualquer falha persistente |
| Tamanho do banco de dados | Supabase Dashboard | > 400MB (limite free tier: 500MB) |
| Erros de crash no app | Sentry | Qualquer novo crash em produção |

### 12.4 Health Check

| Verificação | Frequência | Como |
|-------------|-----------|------|
| Conectividade com Supabase | Ao abrir o app | Ping endpoint de auth |
| Supabase Storage acessível | Antes de download de relatório | HEAD request na URL do arquivo |
| Sync pendente | A cada 30s quando em foreground | Verifica needs_sync no WatermelonDB |

---

## 13. Deployment e Infraestrutura

### 13.1 Ambientes

| Ambiente | Propósito | Supabase Project |
|----------|-----------|-----------------|
| Development | Desenvolvimento local | Projeto Supabase dev separado |
| Staging | Testes de integração | Projeto Supabase staging |
| Production | Produção | Projeto Supabase production |

### 13.2 CI/CD do App Mobile

**Plataforma:** Expo EAS (Expo Application Services)

```
Fluxo de Deploy:
  push → GitHub Actions → lint + type-check + testes
  → eas build (iOS + Android) → eas submit (App Store + Google Play)
  
Canais EAS:
  - development: builds para desenvolvimento e testes internos
  - staging: builds para QA (TestFlight + Google Play Internal Testing)
  - production: builds para loja
```

**OTA Updates:** Expo EAS Update — atualizações de JavaScript/assets sem nova submissão às lojas (para hotfixes e melhorias menores). No **SDK 55**: ativar **Hermes bytecode diffing** (updates ~75% menores) e usar `eas update --environment <env>` (flag agora obrigatória).

> **Requisitos de build (SDK 55):** EAS Build com **Xcode 26** (default 26.2) e **Node 20+**; `@sentry/react-native` **≥ 7.3.0** (versões anteriores quebram o build Android no Gradle 9). Ver [ANALISE_IMPACTO_EXPO_SDK_55.html](../plano/ANALISE_IMPACTO_EXPO_SDK_55.html).

### 13.3 Infraestrutura Supabase

| Componente | Configuração (v1) | Configuração (v2 — se escalar) |
|------------|------------------|-------------------------------|
| Supabase Tier | Free (500MB DB, 1GB Storage) | Pro ($25/mês — 8GB DB, 100GB Storage) |
| Region | sa-east-1 (São Paulo) | sa-east-1 |
| Backups | Supabase automático (daily, 7 dias) | PITR (Point-in-Time Recovery) habilitado |
| Edge Functions | Deno Deploy (incluso) | Incluso |

### 13.4 Publicação nas Lojas

| Loja | Requisito | Observação |
|------|----------|------------|
| Apple App Store | Conta Apple Developer ($99/ano) | App Review: 1-3 dias úteis |
| Google Play Store | Conta Google Play ($25 único) | Revisão: horas a 3 dias |
| Política de LGPD | Privacy Policy URL obrigatória | Apontando para política de privacidade do Sir Barbecue |

---

## 14. Escalabilidade e Resiliência

> **Referência DDIA:** Cap. 1 (Escalabilidade) e Cap. 8 (Problemas em Sistemas Distribuídos).

### 14.1 Considerações de Escala

Em v1, o sistema opera com **um único usuário** — a escala não é preocupação imediata. As decisões abaixo preparam para crescimento futuro (v2 com múltiplos funcionários/múltiplos trailers):

| Componente | Estado Atual (v1) | Caminho para Escala (v2) |
|------------|------------------|--------------------------|
| Supabase (BaaS) | Free tier — escala automática | Upgrade para Pro tier |
| Dados por usuário | < 50MB estimado em 5 anos | RLS já isola por user_id — suporta multi-tenant |
| Edge Functions | Serverless — auto-escala | Sem mudança |
| Push notifications | 1 dispositivo | Múltiplos dispositivos por usuário já suportados |

### 14.2 Resiliência no App Mobile

| Cenário | Comportamento | Implementação |
|---------|--------------|---------------|
| Supabase indisponível | App opera 100% offline | WatermelonDB como fonte primária |
| Falha de sync | Dados não perdidos — permanece em fila | needs_sync=true nunca descartado sem confirmação |
| Crash durante registro de venda | Transação local garante consistência | WatermelonDB transações ACID no SQLite local |
| Dispositivo trocado | Dados na nuvem sincronizam no novo dispositivo | Re-sync completo ao fazer login em novo device |
| Relatório falha de geração | Status `failed` + notificação | Usuário pode solicitar novamente |

### 14.3 Garantias de Durabilidade de Dados

- **Vendas:** gravadas localmente (SQLite) antes de qualquer confirmação de sucesso ao usuário → não há perda
- **Sync:** tentativas com retry exponencial; dados ficam na fila indefinidamente até sync bem-sucedido
- **Backups Supabase:** daily backup automático (7 dias de retenção no free tier; PITR no Pro)
- **Retenção:** dados de vendas mantidos por 5 anos no PostgreSQL (RNF-11 — obrigação fiscal)

---

## 15. Stack Tecnológico Recomendado

| Camada | Tecnologia | Justificativa |
|--------|-----------|---------------|
| Mobile Framework | React Native 0.83.1 + Expo SDK 55 | iOS 15+/Android unificado; TypeScript; New Architecture obrigatória |
| Linguagem | TypeScript | Type safety; manutenibilidade (RNF-12) |
| Navegação | Expo Router v7 (file-based, sobre React Navigation 7) | Padrão de fato no ecossistema React Native |
| State Management | Zustand | Leve, sem boilerplate; suficiente para 1 usuário |
| Banco local (offline) | WatermelonDB (SQLite) | Projetado para mobile offline-first; performance; sync |
| Backend (BaaS) | Supabase | PostgreSQL + Auth + Storage + Edge Functions + Realtime |
| Edge Functions | Deno + TypeScript | Geração de relatórios server-side |
| Geração de PDF | Puppeteer (headless) no Edge Function | PDF de alta qualidade com gráficos |
| Gráficos nos relatórios | Chart.js ou Recharts (renderizado em HTML → PDF) | Amplamente testado; suporte a todos os tipos de gráfico necessários |
| Push Notifications | Expo Notifications + Expo Push Service | Abstrai FCM e APNs em uma única API |
| Autenticação | Supabase Auth (GoTrue) | Email/senha + Google OAuth; tokens no Keychain/Keystore |
| Segurança de armazenamento local | expo-secure-store | Keychain iOS / Keystore Android para tokens |
| CI/CD | Expo EAS Build + EAS Submit | Build e publicação nas lojas integrados |
| OTA Updates | Expo EAS Update | Hotfixes sem nova submissão às lojas |
| Monitoramento / Crash | Sentry (`@sentry/react-native` ≥ 7.3.0) | Crashes, errors e performance; ≥ 7.3.0 exigido p/ Gradle 9 (SDK 55) |
| Analytics (opcional) | Expo Analytics ou Mixpanel | Uso opcional para métricas de comportamento |

---

## 16. Riscos e Trade-offs

| Risco | Probabilidade | Impacto | Mitigação |
|-------|--------------|---------|-----------|
| Vendor lock-in no Supabase | Média | Médio | PostgreSQL padrão — export via pg_dump; Supabase é open-source (self-hosted possível) |
| Limite do plano free Supabase (500MB DB) | Baixa em v1 | Médio | Monitorar uso; upgrade para Pro ($25/mês) antes de atingir 80% |
| WatermelonDB sob New Architecture obrigatória (SDK 55) | Média | Alto | **Spike de validação na Fase 0** (gate); plugins testados até SDK 54 (risco é build, não bridgeless). Plano B: `expo-sqlite` + Drizzle atrás das interfaces de repositório |
| Geração de PDF em Edge Function timeout | Baixa | Médio | Edge Functions têm timeout de 150s; relatórios gerenciais estimados em < 30s; ok |
| Conflitos de sync em operação offline longa | Baixa | Médio | Estratégias de resolução definidas por entidade; vendas nunca perdem dados |
| App rejeitado na App Store | Baixa | Alto | Seguir guidelines Apple; declarar uso de câmera apenas se necessário; LGPD compliance |
| Quebra de contrato de API Supabase após atualização | Baixa | Médio | Versionar integrações; testar em staging antes de produção |
| Accessibilidade insuficiente para deficiência visual | Média | Alto | Testes manuais com VoiceOver/TalkBack desde o desenvolvimento; revisão por especialista acessibilidade |

> **Referência DDIA:** Cap. 12 — Kleppmann discute os trade-offs fundamentais que toda equipe enfrenta ao projetar sistemas de dados. Para Sir Barbecue, o trade-off central é **simplicidade operacional (BaaS) vs controle total (backend próprio)**. A escolha pelo Supabase é correta para o tamanho atual do negócio e pode ser revisada na v2 se a complexidade ou o volume crescerem.

---

*Documento gerado via `/arquiteto-solucoes-sistema` — Claude Code Architecture Skill*
*Baseado em: Designing Data-Intensive Applications — Martin Kleppmann (1ª e 2ª ed.)*
