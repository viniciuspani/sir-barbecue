# Fase 2 — Setup do Supabase (necessário para a auth funcionar)

> **Gerado em:** 2026-06-21
> O código da Fase 2 (login e-mail/senha + Google OAuth, criar conta, recuperar senha, verificação)
> já está implementado. Para funcionar **em runtime**, configure o projeto Supabase + o `.env` abaixo.
> Até lá, o app usa placeholders e o botão **"Entrar sem login (dev)"** (só em dev) libera o shell.

---

## 1. Criar o projeto e pegar as chaves
1. Em [supabase.com](https://supabase.com) → **New project**.
2. **Settings → API** → copie:
   - **Project URL** → `EXPO_PUBLIC_SUPABASE_URL`
   - **anon public key** → `EXPO_PUBLIC_SUPABASE_ANON_KEY`

## 2. `.env` na raiz do projeto
```bash
EXPO_PUBLIC_SUPABASE_URL=https://SEUPROJETO.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```
- O `.env` **não é commitado** (está no `.gitignore`).
- ⚠️ **EAS Build (nuvem) NÃO lê o `.env` local.** Para os builds `preview`/`production`, crie as variáveis no EAS:
  ```bash
  eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value "https://SEUPROJETO.supabase.co" --visibility plaintext
  eas env:create --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "eyJ..." --visibility sensitive
  ```
  (ou pelo dashboard do EAS). Variáveis `EXPO_PUBLIC_*` são **inlinadas no bundle em tempo de build**.

## 3. E-mail / senha (RF-01)
- **Authentication → Providers → Email**: habilitado.
- **Confirm email**: ligado (exige verificação antes de liberar acesso — é o que a tela *Verificação de E-mail* espera). Se desligar, o signup já loga direto.

## 4. Redirect URLs (deep links do app)
**Authentication → URL Configuration → Redirect URLs**, adicione:
```
sirbarbecue://auth-callback     (Google OAuth)
sirbarbecue://reset-password    (recuperação de senha)
```
> O scheme `sirbarbecue` vem do `app.json` (`"scheme": "sirbarbecue"`).

## 5. Google OAuth (RF-02)
1. **Google Cloud Console** → APIs & Services → **Credentials** → criar **OAuth client ID**:
   - Tipo **Web** (o Supabase usa o fluxo web) — anote Client ID + Secret.
   - Em *Authorized redirect URIs*, adicione o callback do Supabase:
     `https://SEUPROJETO.supabase.co/auth/v1/callback`
2. **Supabase → Authentication → Providers → Google**: cole **Client ID** + **Client Secret** e habilite.
3. (Android, opcional p/ login nativo futuro) criar também um OAuth client **Android** com o package `com.labrasa.sirbarbecue` e o SHA-1 do keystore do EAS.

## 6. Testar (RF-01/02)
1. `npm run deploy:preview` (com as env vars do EAS configuradas) → instalar no device.
2. **Criar conta** → recebe e-mail → confirmar → **login**.
3. **Login com Google** → navegador abre → consente → volta logado.
4. **Recuperar senha** → recebe o e-mail de reset.

---

## Pendências conhecidas (follow-ups da Fase 2)
- ✅ **Reset de senha via deep link — implementado** (`app/reset-password.tsx`: troca o `code` + `updateUser({ password })`). Garanta que `sirbarbecue://reset-password` está nos *Redirect URLs* do Supabase.
- **Token de push (RF-11/22)** e **deep link de OAuth em produção:** validar no device com as credenciais reais.
- **`LargeSecureStore` (chunking):** se a sessão do Supabase passar de ~2KB, o `expo-secure-store` avisa — trocar por um adapter com chunking.

---

*Referência de arquitetura: ADR-005 (Supabase Auth) em `docs/arquitetura/01a` · seção 8 de `docs/arquitetura/01c`.*
