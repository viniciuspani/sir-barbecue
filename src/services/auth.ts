import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import { supabase } from '@/data/remote/supabaseClient';

// Finaliza sessões de auth pendentes ao voltar do navegador (Google OAuth).
WebBrowser.maybeCompleteAuthSession();

export type AuthResult = { error: string | null };

const APP_SCHEME = 'sirbarbecue';

function msg(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return 'Erro inesperado. Tente novamente.';
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  return { error: error ? msg(error) : null };
}

export async function signUpWithEmail(
  email: string,
  password: string,
  businessName?: string,
): Promise<AuthResult & { needsConfirmation: boolean }> {
  // `business_name` vai no metadado do usuário → o trigger handle_new_user nomeia a 1ª empresa.
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { business_name: businessName?.trim() || undefined } },
  });
  return { error: error ? msg(error) : null, needsConfirmation: !!data?.user && !data.session };
}

export async function resendConfirmation(email: string): Promise<AuthResult> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
  return { error: error ? msg(error) : null };
}

export async function resetPassword(email: string): Promise<AuthResult> {
  const redirectTo = makeRedirectUri({ scheme: APP_SCHEME, path: 'reset-password' });
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  return { error: error ? msg(error) : null };
}

export async function updatePassword(password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.updateUser({ password });
  return { error: error ? msg(error) : null };
}

export async function signInWithGoogle(): Promise<AuthResult & { cancelled?: boolean }> {
  try {
    const redirectTo = makeRedirectUri({ scheme: APP_SCHEME, path: 'auth-callback' });
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) return { error: msg(error) };
    if (!data?.url) return { error: 'Não foi possível iniciar o login com Google.' };

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') return { error: null, cancelled: true };

    const code = new URL(result.url).searchParams.get('code');
    if (!code) return { error: 'Resposta de login inválida.' };

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    return { error: exchangeError ? msg(exchangeError) : null };
  } catch (e) {
    return { error: msg(e) };
  }
}
