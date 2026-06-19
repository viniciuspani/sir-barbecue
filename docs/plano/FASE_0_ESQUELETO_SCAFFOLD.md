# Esqueleto da Fase 0 — Scaffold & Tooling (Sir Barbecue)

> **Gerado em:** 2026-06-19
> **Stack alvo:** Expo SDK 55 / React Native 0.83.1 / React 19.2 / TypeScript — **New Architecture obrigatória**, offline-first
> **Base:** [PLANO_IMPLEMENTACAO_TELAS.md](./PLANO_IMPLEMENTACAO_TELAS.md) · [ANALISE_IMPACTO_EXPO_SDK_55.html](./ANALISE_IMPACTO_EXPO_SDK_55.html) · `docs/arquitetura/*`
> **Status:** executado em 19/06/2026 — scaffold criado, deps instaladas, **gate local verde** (`tsc` 0 / `eslint` 0 / `expo-doctor` 19-19) e `expo prebuild -p android` OK (WDB fiado no Gradle). **Gate no device pendente** (Android SDK/EAS). Ver "Gotchas reais".

---

## Objetivo da Fase 0

Deixar o projeto **compilando em dev build** (iOS + Android) na **New Architecture**, com a estrutura **Clean Architecture**, o **design system base** e o tooling de qualidade. O entregável crítico é o **gate do WatermelonDB** (§6): validar a compatibilidade com a New Arch obrigatória — ou acionar o **Plano B (Drizzle)** ainda aqui, antes de qualquer tela de negócio.

> ⚠️ **WatermelonDB e push notifications NÃO rodam no Expo Go.** Toda a Fase 0 usa **development build** (`expo prebuild` + `run:ios`/`run:android` ou EAS dev build).

**Resultado esperado:** fundação técnica pronta; **nenhuma** tela de negócio (essas começam na Fase 1).

---

## Gotchas reais validados na execução (19/06/2026)

> Itens descobertos ao executar o scaffold de fato. Já aplicados ao projeto — seguindo-os, `tsc` / `eslint` / `expo-doctor` passam limpos.

| # | Gotcha | Sintoma | Correção aplicada |
|---|--------|---------|-------------------|
| 1 | **`.npmrc` com `legacy-peer-deps=true`** | `npm ERESOLVE`: `react-dom@19.2.7` (puxado pelo expo-router/web via vaul/radix) exige `react ^19.2.7`, mas o SDK 55 fixa `react 19.2.0`. | Criar `.npmrc` na raiz **antes** de instalar. |
| 2 | **`experimentalDecorators: true` no `tsconfig`** | `tsc` falha com **TS1240** nos models do WatermelonDB (`@text`/`@field`) — TS 5.x os trata como decorators ES novos. | Adicionar `"experimentalDecorators": true` em `compilerOptions`. |
| 3 | **Remover `newArchEnabled` e `edgeToEdgeEnabled` do `app.json`** | `expo-doctor`: "should NOT have additional property 'newArchEnabled' / 'edgeToEdgeEnabled'" (campos removidos no SDK 55). | Não declarar esses campos (New Arch e edge-to-edge são mandatórios). |
| 4 | **Peer deps do expo-router** | `expo-doctor`: "Missing peer dependency: expo-constants / expo-linking". | `npx expo install expo-constants expo-linking`. |
| 5 | **Exclusão do WatermelonDB no `expo-doctor`** | `expo-doctor`: "Untested on New Architecture: @nozbe/watermelondb" + "No metadata: @nozbe/simdjson". | `expo.doctor.reactNativeDirectoryCheck.exclude` no `package.json` (risco conhecido — validado pelo spike no device, não pelo doctor). |
| + | **`expo-system-ui`** | `prebuild`: "Install expo-system-ui ... to enable userInterfaceStyle". | `npx expo install expo-system-ui` (faz o tema escuro `dark` valer). |
| + | **Plugin de worklets** | bundle quebra com plugin errado. | Reanimated **4.x** (instalado: 4.2.1) usa `react-native-worklets/plugin` no Babel — não `react-native-reanimated/plugin`. |

**Snippets prontos:**

```ini
# .npmrc (raiz)
legacy-peer-deps=true
```

```jsonc
// package.json — silencia o check do RN Directory p/ o WDB (risco conhecido = gate no device)
"expo": {
  "doctor": {
    "reactNativeDirectoryCheck": {
      "exclude": ["@nozbe/watermelondb", "@nozbe/simdjson"],
      "listUnknownPackages": false
    }
  }
}
```

---

## 0. Pré-requisitos do ambiente

| Item | Versão / Observação |
|------|---------------------|
| Node.js | **≥ 20.19.4** (ou 22.13+) — `node -v` |
| Gerenciador | npm (ou pnpm/yarn) |
| EAS CLI | `npm i -g eas-cli` → `eas login` |
| iOS (build local) | **Xcode 26+**; CocoaPods. *Ou* usar EAS Build na nuvem (default Xcode 26.2) |
| Android | Android Studio + SDK **compileSdk 36**; **JDK 17** |
| Device | Emulador/simulador **ou** device físico (recomendado p/ o spike do WatermelonDB) |
| Watchman | recomendado no macOS |

---

## 1. Criar o projeto (SDK 55)

```bash
npx create-expo-app@latest sir-barbecue --template blank-typescript
cd sir-barbecue
printf "legacy-peer-deps=true\n" > .npmrc   # gotcha #1 — evita o ERESOLVE react/react-dom
npx expo install expo@^55      # fixa o SDK 55 (o create-expo-app@latest hoje já vem com 56)
npx expo install --fix         # alinha react/react-native/expo-* ao SDK 55
npx expo-doctor                # precisa passar limpo
```

Confirmar no `package.json` (resolvido pelo `expo install`): `expo` em `^55`, `react-native` `0.83.x`, `react` `19.2.x`. **Não** adicionar `newArchEnabled`/`sdkVersion`/`jsEngine`/`edgeToEdgeEnabled` ao `app.json` — New Arch, Hermes e edge-to-edge são padrão/obrigatórios no SDK 55, e o `expo-doctor` **rejeita** esses campos (gotcha #3).

---

## 2. Estrutura de pastas (Clean Architecture)

```
app/                      # Rotas Expo Router v7 (Presentation)
  _layout.tsx             # provider raiz (theme, stores, gesture-handler, SafeArea)
  index.tsx               # Splash → gate de sessão
  (auth)/ (app)/ ...      # (telas entram a partir da Fase 1)
src/
  design/        # tokens.ts (porta do CSS de design), theme.ts, typography.ts
  ui/            # Button, Input, Card, Chip, Badge, Toggle, ProgressBar, ScreenHeader, EmptyState, Sheet
  domain/        # entities/, usecases/, repositories/ (interfaces) — TS puro
  data/
    local/       # WatermelonDB: schema.ts, migrations.ts, models/, database.ts
    remote/      # supabaseClient.ts, DTOs, mappers
    repositories/# implementações (Product, Sale, Stock, Supplier, Report)
    sync/        # syncEngine.ts, offlineQueue.ts (RF-16, retry/backoff)
  store/         # zustand: authStore, connectivityStore, syncStore, cartStore
  services/      # notifications.ts, secureStorage.ts, netinfo.ts
  lib/           # currency (R$), dates (pt-BR), a11y helpers, weekday
```

> A pasta `app/` na raiz casa com o Expo Router file-based já documentado no PLANO. O `src/` isola Domain/Data — é o que permite trocar o WatermelonDB pelo Plano B sem tocar em Presentation/Domain.

---

## 3. `app.json` — plugins e config (SDK 55)

Pontos-chave: **não** declarar campos removidos (`newArchEnabled`, `sdkVersion`, `statusBar`, `notification`, `edgeToEdgeEnabled`); notificações via **config plugin**; edge-to-edge tratado por código (SafeArea).

```jsonc
{
  "expo": {
    "name": "Sir Barbecue",
    "slug": "sir-barbecue",
    "scheme": "sirbarbecue",
    "ios": { "supportsTablet": false, "bundleIdentifier": "com.labrasa.sirbarbecue" },
    "android": { "package": "com.labrasa.sirbarbecue" },
    "plugins": [
      "expo-router",
      "expo-secure-store",
      "expo-font",
      ["expo-notifications", { "icon": "./assets/notification-icon.png", "color": "#D4A017" }],
      ["@morrowdigital/watermelondb-expo-plugin"],
      ["expo-build-properties", { "android": { "compileSdkVersion": 36, "targetSdkVersion": 36 } }]
    ]
  }
}
```

> `expo-build-properties` é opcional — inclua se o spike do WatermelonDB pedir ajuste de `compileSdk`/NDK no Android.

---

## 4. Dependências (sempre via `expo install`)

```bash
# Navegação / runtime (expo-constants + expo-linking são peer deps do expo-router — gotcha #4)
npx expo install expo-router expo-constants expo-linking react-native-safe-area-context react-native-screens

# UI nativa / status bar / tema escuro (userInterfaceStyle: dark — gotcha +)
npx expo install expo-status-bar expo-system-ui

# Estado
npm i zustand

# BD local offline (WatermelonDB) + decorators
npx expo install @nozbe/watermelondb
npm i -D @babel/plugin-proposal-decorators
npm i -D @morrowdigital/watermelondb-expo-plugin

# Backend (Supabase)
npx expo install @supabase/supabase-js react-native-url-polyfill

# Seguro / push / conectividade
npx expo install expo-secure-store expo-notifications @react-native-community/netinfo

# Animações / gestos / bottom sheet
npx expo install react-native-reanimated react-native-worklets react-native-gesture-handler
npm i @gorhom/bottom-sheet@^5

# Gráficos (primário: gifted-charts)
npx expo install react-native-gifted-charts react-native-svg

# Relatórios (HTML + download/share)
npx expo install react-native-webview expo-file-system expo-sharing

# Auth (Google OAuth via PKCE)
npx expo install expo-auth-session expo-web-browser expo-crypto

# Fontes (Inter — RNF-05)
npx expo install expo-font @expo-google-fonts/inter

# Observabilidade — Sentry (≥ 7.3.0 por causa do Gradle 9 no SDK 55)
npx expo install @sentry/react-native
```

> Após instalar, rode `npx expo-doctor` para confirmar que todas as libs declaram suporte à **New Architecture**. Pin `@sentry/react-native` em **≥ 7.3.0** (de pref. 7.10+); **não** use o legado `sentry-expo`.

---

## 5. Config: Babel, TypeScript, Metro

**`babel.config.js`** — decorators (WatermelonDB) + plugin de worklets (Reanimated). O plugin de worklets deve ser o **último**.

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['@babel/plugin-proposal-decorators', { legacy: true }], // WatermelonDB
      'react-native-worklets/plugin',                          // Reanimated 4.x — SEMPRE por último
    ],
  };
};
```

> ⚠️ **Reanimated 4.x** (instalado: 4.2.1) usa o pacote separado `react-native-worklets` e o plugin `react-native-worklets/plugin` (sempre por último). Em Reanimated 3.x seria `react-native-reanimated/plugin`.

**`tsconfig.json`** — strict (RNF-12):

```jsonc
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "experimentalDecorators": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
```

> ⚠️ `experimentalDecorators: true` (gotcha #2) é **obrigatório** — sem ele o `tsc` quebra nos decorators do WatermelonDB (TS1240).

---

## 6. GATE — Spike do WatermelonDB (decisivo)

Objetivo: provar que o adapter **JSI** do WatermelonDB sobe na **New Architecture** (RN 0.83.1) em iOS **e** Android. Este é o ponto condicionalmente bloqueante da arquitetura (ADR-003).

**Esqueleto mínimo do spike:**

```ts
// src/data/local/schema.ts
import { appSchema, tableSchema } from '@nozbe/watermelondb';
export default appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'products',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'price', type: 'number' },
        { name: 'is_active', type: 'boolean' },
        { name: 'client_id', type: 'string', isIndexed: true }, // idempotência de sync
        { name: 'needs_sync', type: 'boolean' },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
  ],
});
```

```ts
// src/data/local/models/Product.ts
import { Model } from '@nozbe/watermelondb';
import { field, text } from '@nozbe/watermelondb/decorators';
export default class Product extends Model {
  static table = 'products';
  @text('name') name!: string;
  @field('price') price!: number;
  @field('is_active') isActive!: boolean;
  @field('client_id') clientId!: string;
  @field('needs_sync') needsSync!: boolean;
}
```

```ts
// src/data/local/database.ts
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import schema from './schema';
import Product from './models/Product';

const adapter = new SQLiteAdapter({
  schema,
  jsi: true,                       // <-- chave da New Architecture
  onSetUpError: (e) => console.error('[WDB] setup error', e),
});

export const database = new Database({ adapter, modelClasses: [Product] });
```

**Executar o build de desenvolvimento:**

```bash
npx expo prebuild --clean
npx expo run:android        # device/emulador físico de preferência
npx expo run:ios
```

**Critérios de aceite (gate):**

1. App sobe confirmadamente na **New Architecture** (sem erro de bridge/Fabric).
2. O **JSI inicializa** (sem crash do adapter; `onSetUpError` não dispara).
3. **CRUD + transação ACID**: criar/editar/excluir `Product` dentro de `database.write(...)` funciona.
4. **Observables reativos**: uma query observada re-renderiza ao alterar dados (padrão Observer).
5. **Estável em iOS e Android** (ambos os `run:*`).

> ✅ **Todos passam →** segue com WatermelonDB; o risco da arquitetura cai para **BAIXO**.
> ❌ **Qualquer um falha →** aciona o **Plano B (§7)** ainda na Fase 0. As interfaces de repositório no Domain não mudam.

---

## 7. Plano B — `expo-sqlite` + Drizzle (só se o gate §6 reprovar)

```bash
npx expo install expo-sqlite
npm i drizzle-orm
npm i -D drizzle-kit babel-plugin-inline-import
```

- **Schema/queries:** `drizzle-orm/expo-sqlite`; migrations com `drizzle-kit` + `migrate()` no `onInit` do `SQLiteProvider`.
- **Reatividade:** `useLiveQuery` (observa mudanças e re-renderiza) — substitui os observables do WatermelonDB sem polling.
- **Sync:** o `syncEngine`/`offlineQueue` já são código próprio — manter `client_id` (idempotência), `needs_sync`/`synced_at`, retry/backoff e estratégias client-wins (vendas) / server-wins (catálogo), conforme `docs/arquitetura/02b`.
- **Regra de ouro:** trocar **apenas** `src/data/local/` e as implementações em `src/data/repositories/`. **Nenhuma tela e nenhum use case mudam.**

---

## 8. Design system base (porta do HTML de design)

Extrair os tokens do `:root` de `docs/design/telas_la_brasa.html` para `src/design/tokens.ts`:

```ts
// src/design/tokens.ts
export const colors = {
  bg: '#1A1A1A', surface: '#252525', gold: '#D4A017', red: '#8B1E1E',
  textPrimary: '#FFFFFF', textSecondary: '#B3B3B3', divider: '#333333',
  green: '#3FB950', yellow: '#D4A017',
};
export const radii = { sm: 8, md: 12, lg: 16 };
export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
```

- **Tipografia Inter** via `expo-font` / `@expo-google-fonts/inter`, escala respeitando **RNF-05** (corpo ≥ 16sp, ações ≥ 18sp).
- **Componentes base** catalogados a partir das classes `.btn`, `.input-field`, `.card`, `.chip`, `.badge`, `.toggle`, `.progress-bar`.
- **A11y desde o início:** `accessibilityLabel/Role`, alvos de toque **≥ 48dp**, contraste AA, **edge-to-edge** via `SafeAreaProvider`/insets no `app/_layout.tsx`.

---

## 9. Qualidade — ESLint, Prettier e scripts

```bash
npx expo install eslint eslint-config-expo prettier
```

`package.json` (scripts):

```jsonc
{
  "scripts": {
    "start": "expo start --dev-client",
    "android": "expo run:android",
    "ios": "expo run:ios",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "doctor": "expo-doctor"
  }
}
```

> **Disciplina do RN 0.83:** *unhandled promise rejections* agora viram **erro**. Padronize `try/catch`/`.catch()` em todo `await` (sync engine, repositórios, Supabase, file-system) — considere uma regra de lint para isso.

---

## 10. `.env` / segredos (necessários para as próximas fases)

```bash
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
# Google OAuth (RF-02) — usados na Fase 2
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=...
```

- Não commitar `.env`. No EAS, usar **EAS Environment Variables** (e lembrar: `eas update` agora exige `--environment <env>`).
- `supabaseClient.ts` importa `react-native-url-polyfill/auto` no topo.

---

## 11. Definition of Done — Fase 0

- [ ] `npx expo-doctor` verde no scaffold SDK 55 (com `.npmrc` `legacy-peer-deps`, `tsconfig` `experimentalDecorators`, peer deps `expo-constants`/`expo-linking`, `expo-system-ui` e a exclusão do WDB no `package.json` — ver "Gotchas reais").
- [ ] `tsc --noEmit` e `eslint .` sem erros.
- [ ] `app.json` sem `newArchEnabled`/`sdkVersion`/`statusBar`/`notification`/`edgeToEdgeEnabled`; plugins de `expo-notifications` + WatermelonDB presentes.
- [ ] **Gate do WatermelonDB aprovado em iOS + Android** (JSI + ACID + observables) — **ou** Plano B (Drizzle) ativado e validado.
- [ ] Reanimated (+ `react-native-worklets`) + `@gorhom/bottom-sheet` v5 sobem no dev build.
- [ ] `@sentry/react-native` **≥ 7.3.0**; build Android (EAS) passa.
- [ ] Estrutura de pastas Clean Architecture criada; `tsconfig` strict; ESLint/Prettier configurados.
- [ ] Design tokens + Inter + tema base; `SafeAreaProvider`/edge-to-edge no layout raiz.
- [ ] `.env` (ou EAS env vars) com chaves Supabase; `supabaseClient.ts` com url-polyfill.
- [ ] Dev build instalável rodando em pelo menos 1 device por plataforma.

---

## 12. Próximo passo

**Fase 1 — Shell de navegação** (PLANO §Fases): tabs (Início, Venda, Produtos, Estoque, Mais) + stacks aninhados no Expo Router **v7**; Splash com gate de sessão. A partir daqui entram as telas de negócio.

---

*Documento de scaffold da Fase 0 — derivado de [ANALISE_IMPACTO_EXPO_SDK_55.html](./ANALISE_IMPACTO_EXPO_SDK_55.html) e [PLANO_IMPLEMENTACAO_TELAS.md](./PLANO_IMPLEMENTACAO_TELAS.md).*
