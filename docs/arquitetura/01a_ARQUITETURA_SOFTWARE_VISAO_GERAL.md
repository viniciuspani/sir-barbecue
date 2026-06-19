# Arquitetura de Software — Sir Barbecue

> **Fase:** 1 de 3 — Visão Geral e Decisões Arquiteturais
> **Versão:** 1.1 (revisada para Expo SDK 55 em 19/06/2026 — ver [ANALISE_IMPACTO_EXPO_SDK_55.html](../plano/ANALISE_IMPACTO_EXPO_SDK_55.html))
> **Data:** 07/06/2026
> **Elaborado por:** Arquiteto de Soluções (gerado via /arquiteto-solucoes-sistema)
> **Baseado em:** Designing Data-Intensive Applications — Martin Kleppmann
> **Próximo documento:** [01b_ARQUITETURA_SOFTWARE_COMPONENTES_API.md](./01b_ARQUITETURA_SOFTWARE_COMPONENTES_API.md)

---

## Índice desta Fase

1. [Visão Geral do Sistema](#1-visão-geral-do-sistema)
2. [Decisões Arquiteturais (ADR)](#2-decisões-arquiteturais-adr)
3. [Estilo e Padrão Arquitetural](#3-estilo-e-padrão-arquitetural)

---

## 1. Visão Geral do Sistema

### 1.1 Propósito

Sir Barbecue é um aplicativo mobile para gestão completa de um trailer de churrasquinho. Resolve o problema de controle operacional informal (cadernos, planilhas, memória) ao centralizar no smartphone do proprietário: registro de vendas, controle de estoque, gestão de fornecedores e geração de relatórios financeiros — com suporte completo a operação sem internet.

**Usuário-alvo:** Proprietária do negócio, perfil não técnico. Uma das usuárias possui deficiência visual parcial (enxerga apenas com um olho), o que impõe requisitos específicos de acessibilidade e legibilidade.

### 1.2 Características Críticas do Sistema

| Característica | Nível | Justificativa |
|----------------|-------|---------------|
| Disponibilidade | 99,5% (online) + 100% offline | Vendas não podem parar por indisponibilidade do servidor |
| Consistência | Eventual (offline-first) + Forte para dados financeiros | Prioridade é operar sem internet; consistência financeira garantida no sync |
| Latência | < 1s (telas com cache), < 2s (operações online) | RNF-01 e RNF-02 — fluidez em rede 4G/5G |
| Throughput | ~50 vendas/dia, 1 usuário simultâneo | Baixo volume — pequeno negócio |
| Escalabilidade | Vertical (v1) — expansão horizontal possível na v2 | Usuário único não exige escala horizontal imediata |
| Retenção de dados | 5 anos mínimo | RNF-11 — obrigação fiscal |

### 1.3 Contexto e Fronteiras do Sistema

O sistema opera **sem integrações técnicas externas** em v1. O contexto externo relevante:

| Sistema Externo | Tipo | Direção | Protocolo |
|-----------------|------|---------|-----------|
| Google OAuth 2.0 | Autenticação social | Entrada | HTTPS/OAuth 2.0 |
| Firebase Cloud Messaging (FCM) | Push notifications | Saída | HTTPS |
| Apple Push Notification Service (APNs) | Push notifications iOS | Saída | HTTPS |
| Supabase Storage / S3 | Armazenamento de PDFs e HTMLs | Saída | HTTPS |

**Fora do escopo (v1):**
- Integração com terminal físico de cartão (registrado apenas como forma de pagamento)
- Integração com Instagram
- Impressão via Bluetooth (preparação arquitetural prevista em RNF-13)
- Cadastro de clientes (vendas são anônimas)
- Múltiplos usuários

---

## 2. Decisões Arquiteturais (ADR)

> ADR = Architecture Decision Record. Cada decisão relevante documentada com alternativas e motivo da escolha.

---

### ADR-001 — Framework Mobile: React Native (Expo) vs Flutter

| Campo | Valor |
|-------|-------|
| **Status** | Aceito |
| **Data** | 07/06/2026 |

**Contexto:**
O sistema deve funcionar em iOS 15+ e Android 10+ com uma única base de código. A equipe precisa de maturidade no ecossistema escolhido, bom suporte a SQLite local para offline, e integração nativa com recursos de acessibilidade das plataformas (VoiceOver/TalkBack).

**Alternativas Consideradas:**

| Alternativa | Prós | Contras |
|-------------|------|---------|
| React Native + Expo | Ecossistema JS/TS maduro; Expo simplifica build; excelente integração Firebase/Supabase; WatermelonDB para offline; componentes de acessibilidade via React Native Accessibility API | Performance ligeiramente inferior ao Flutter em animações pesadas |
| Flutter | Performance nativa excelente; Dart forte; boas bibliotecas | Ecossistema menor; integração com Firebase/Supabase menos madura que RN; Dart menos difundido |
| Nativo (SwiftUI + Jetpack Compose) | Performance máxima, acesso total a APIs nativas | Dois codebases, custo dobrado de manutenção |

**Decisão:**
**React Native com Expo (Managed Workflow).** O ecossistema TypeScript, a integração direta com Supabase SDK, WatermelonDB para offline-first, e as APIs de acessibilidade nativas via React Native Accessibility fazem desta a escolha mais produtiva e manutenível para equipes JS/TS.

**Consequências:**
- Necessita de Expo EAS Build para distribuição na App Store e Google Play
- Performance suficiente para o volume de dados deste sistema (pequeno negócio)
- Expo Notifications abstrai FCM (Android) e APNs (iOS) em uma única API
- **Atualização SDK 55 (19/06/2026):** alvo passa a **Expo SDK 55 / RN 0.83.1 / React 19.2**; a **New Architecture deixa de ser opcional e torna-se obrigatória** (Legacy removida). O piso de **iOS 15+** é mantido — o SDK 56 exigiria iOS 16.4+. Ver [análise de impacto](../plano/ANALISE_IMPACTO_EXPO_SDK_55.html).

---

### ADR-002 — Backend: Supabase (BaaS) vs Backend Customizado

| Campo | Valor |
|-------|-------|
| **Status** | Aceito |
| **Data** | 07/06/2026 |

**Contexto:**
O sistema tem **um único usuário** com volume baixo de dados. Montar infraestrutura de backend customizado (Node.js + API + Docker + CI/CD) representa overhead desproporcional ao tamanho do negócio e da equipe.

**Alternativas Consideradas:**

| Alternativa | Prós | Contras |
|-------------|------|---------|
| **Supabase** | PostgreSQL gerenciado; Auth nativa (email + OAuth); Storage; Edge Functions; Realtime; SDK mobile; Plano gratuito generoso | Vendor lock-in; limites no plano free (500MB DB, 1GB storage) |
| Firebase (Google) | Mature; excelente offline com Firestore; Push notifications nativo | NoSQL (menos adequado para relatórios com joins complexos); custo pode escalar |
| Node.js + PostgreSQL + Redis customizado | Controle total; sem lock-in | Muito overhead para 1 usuário; custo de infra maior; CI/CD necessário |

**Decisão:**
**Supabase.** PostgreSQL como banco de dados (ideal para os relatórios com JOINs complexos), autenticação built-in com Google OAuth, Storage para PDFs/HTMLs de relatórios, Edge Functions para geração assíncrona de relatórios, e Realtime para sincronização offline. Reduz time-to-market significativamente para um app de pequeno negócio.

**Mitigação do vendor lock-in:** O banco de dados é PostgreSQL padrão — migration para instância própria é possível a qualquer momento via `pg_dump`.

**Consequências:**
- Elimina necessidade de servidor, Docker, CI/CD de backend em v1
- Row Level Security (RLS) do PostgreSQL garante isolamento por usuário
- Limites do plano gratuito Supabase são suficientes para v1 (< 500MB de dados de operação, 1 usuário)
- Se o negócio crescer para múltiplos usuários (v2), migração para plano pago ou self-hosted Supabase

---

### ADR-003 — Estratégia Offline: WatermelonDB vs SQLite Manual

| Campo | Valor |
|-------|-------|
| **Status** | Aceito |
| **Data** | 07/06/2026 |

**Contexto:**
RF-15 e RF-16 exigem que vendas sejam registradas sem internet e sincronizadas ao reconectar. Esta é a funcionalidade mais crítica do sistema — a proprietária opera em locais com sinal instável.

**Alternativas Consideradas:**

| Alternativa | Prós | Contras |
|-------------|------|---------|
| **WatermelonDB** | Projetado para React Native; SQLite local; API de sync built-in; performance excelente em mobile; lida com conflitos | Complexidade inicial de setup; curva de aprendizado |
| Expo SQLite + sync manual | Controle total sobre sync logic | Muito trabalho manual; difícil lidar com conflitos |
| MMKV (key-value) | Ultra-rápido | Não é adequado para dados relacionais com queries complexas |
| Realm | Bom para mobile | Sync requer MongoDB Atlas (vendor lock-in adicional); custo |

**Decisão:**
**WatermelonDB com Supabase como servidor de sync.** WatermelonDB usa SQLite localmente e foi projetado especificamente para o padrão offline-first em React Native. O protocolo de sync é implementado contra a API do Supabase.

**Consequências:**
- Todas as operações de leitura e escrita no app operam sobre o banco local (SQLite via WatermelonDB)
- Sync com Supabase ocorre em background quando há conectividade
- Conflitos de sync: estratégia "server wins" exceto para vendas registradas offline (estratégia "client wins" com timestamp)
- **Atualização SDK 55 (19/06/2026):** com a New Architecture obrigatória, a compatibilidade do WatermelonDB (RN 0.83.1) passa por um **spike de validação na Fase 0** (gate de decisão). **Plano B homologado** caso reprove: `expo-sqlite` + Drizzle (`useLiveQuery`) atrás das mesmas interfaces de repositório — Presentation e Domain não mudam. Ver [análise de impacto](../plano/ANALISE_IMPACTO_EXPO_SDK_55.html).

---

### ADR-004 — Geração de Relatórios: Edge Functions vs No Dispositivo

| Campo | Valor |
|-------|-------|
| **Status** | Aceito |
| **Data** | 07/06/2026 |

**Contexto:**
RF-21 a RF-26 requerem geração assíncrona de relatórios em PDF e HTML com gráficos. A geração não deve bloquear o uso do app (RNF-02).

**Alternativas Consideradas:**

| Alternativa | Prós | Contras |
|-------------|------|---------|
| **Supabase Edge Functions (servidor)** | Não consome bateria/CPU do dispositivo; PDF de qualidade com Puppeteer/React-PDF; HTML rico | Requer conectividade; latência de geração |
| Geração no dispositivo (react-native-pdf-lib) | Funciona offline | Limitado; performance ruim para relatórios com gráficos; consome bateria |
| Hybrid: layout no cliente, render no servidor | Flexível | Complexidade maior |

**Decisão:**
**Supabase Edge Functions** para geração server-side. O usuário solicita o relatório, o Edge Function processa em background, e uma notificação push avisa quando está pronto (RF-22). O PDF fica armazenado no Supabase Storage para download (RF-24).

**Consequências:**
- Relatórios exigem conexão (aceitável — gerar relatório fora do momento de venda)
- Push notification ao concluir garante UX fluída (RF-22)
- PDF armazenado no Storage é acessível sem regenerar

---

### ADR-005 — Autenticação: Supabase Auth vs Firebase Auth vs Auth Próprio

| Campo | Valor |
|-------|-------|
| **Status** | Aceito |
| **Data** | 07/06/2026 |

**Contexto:**
RF-01 requer email/senha com verificação, RF-02 requer Google OAuth. RNF-07 exige tokens armazenados de forma segura (Keychain/Keystore).

**Decisão:**
**Supabase Auth** (incluso no Supabase). Suporta email/senha com verificação, Google OAuth nativo, tokens JWT com refresh automático, e o SDK mobile armazena tokens no Keychain (iOS) e Keystore (Android) por padrão. Sem custo adicional.

---

### ADR-006 — Gerenciamento de Estado Mobile: Zustand vs Redux

| Campo | Valor |
|-------|-------|
| **Status** | Aceito |
| **Data** | 07/06/2026 |

**Contexto:**
App de usuário único com estado relativamente simples (auth, dados locais via WatermelonDB, status de sync). Redux seria overkill.

**Decisão:**
**Zustand** para estado global do app (auth state, sync status, connectivity state, offline queue status). WatermelonDB gerencia o estado de dados diretamente via seus observables. Combinação resulta em código mínimo e eficiente.

---

## 3. Estilo e Padrão Arquitetural

### 3.1 Estilo Arquitetural Adotado

**Estilo Mobile:** Clean Architecture (Camadas: Presentation → Domain → Data)

**Estilo Backend:** Backend as a Service (BaaS) via Supabase — sem servidor customizado em v1

**Padrão principal:** Offline-First — o app funciona integralmente sem internet; o servidor é tratado como mecanismo de sincronização e persistência durável, não como dependência de operação.

**Justificativa:**
Clean Architecture para mobile garante a separação clara exigida em RNF-12 (manutenibilidade, módulos desacoplados) e facilita a preparação para integração com terminal físico (RNF-13) e impressora Bluetooth (RNF-13) sem refatoração do núcleo.

### 3.2 Camadas da Clean Architecture Mobile

```
┌─────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER (UI)                                │
│  Screens, Components, ViewModels (Zustand)              │
│  React Native + Expo                                    │
├─────────────────────────────────────────────────────────┤
│  DOMAIN LAYER (Regras de Negócio)                       │
│  Use Cases, Entities, Repository Interfaces             │
│  TypeScript puro — sem dependências externas            │
├─────────────────────────────────────────────────────────┤
│  DATA LAYER (Fontes de Dados)                           │
│  WatermelonDB (local SQLite) — fonte primária           │
│  Supabase Client (remoto) — sync e persistência durável │
│  Sync Engine — orquestra conflitos e fila offline       │
└─────────────────────────────────────────────────────────┘
```

### 3.3 Padrões de Design Aplicados

| Padrão | Onde Aplicado | Motivo |
|--------|--------------|--------|
| Repository Pattern | Camada de dados | Abstrai WatermelonDB e Supabase atrás de interfaces — facilita testes e troca de implementação |
| Observer (Reactive) | WatermelonDB → UI | Telas reagem automaticamente a mudanças locais sem polling |
| Command (Use Cases) | Domínio | Cada ação de negócio é um Use Case isolado e testável |
| Offline Queue | Sync Engine | Operações offline enfileiradas e reprocessadas ao reconectar |
| BFF Pattern | Supabase Edge Functions | Functions servem como BFF customizado para operações específicas (geração de relatório, cálculo de margens) |
| Strategy Pattern | Geração de Relatórios | Estratégia de geração intercambiável: PDF ou HTML |
| Facade | Supabase Client Wrapper | Abstrai chamadas Supabase para facilitar mocks em testes |

> **Referência DDIA:** Cap. 1 — Kleppmann define sistemas data-intensive pela tríade Confiabilidade, Escalabilidade e Manutenibilidade. A Clean Architecture garante Manutenibilidade; offline-first garante Confiabilidade em condições adversas de rede.

---

*Documento gerado via `/arquiteto-solucoes-sistema` — Claude Code Architecture Skill*
*Baseado em: Designing Data-Intensive Applications — Martin Kleppmann (1ª e 2ª ed.)*
