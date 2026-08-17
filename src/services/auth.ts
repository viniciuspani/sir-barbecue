import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import { supabase } from '@/data/remote/supabaseClient';
import { logSilently } from '@/lib/feedback';

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

// Falha de autenticação acontece ANTES de existir empresa ativa: o log fica local
// e só sobe no primeiro sync após o login (marcado como preAuth no contexto).
// A senha nunca entra no registro — o objeto de erro do Supabase não a carrega e
// o redator do errorLog mascara qualquer campo sensível que apareça.
function record(error: unknown, action: string): void {
  if (error) logSilently(error, { action, screen: 'auth' });
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  record(error, 'Entrar com e-mail e senha');
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
  record(error, 'Criar conta');
  return { error: error ? msg(error) : null, needsConfirmation: !!data?.user && !data.session };
}

/**
 * Checa (antes do login) se o e-mail tem um convite PENDENTE para entrar numa
 * empresa existente. Usa a RPC pública has_pending_invite (só devolve booleano).
 * Se falhar/offline, assume `false` (trata como usuário novo → pede empresa).
 */
export async function hasPendingInvite(email: string): Promise<boolean> {
  const trimmed = email.trim();
  if (!trimmed) return false;
  const { data, error } = await supabase.rpc('has_pending_invite', { p_email: trimmed });
  record(error, 'Verificar convite pendente');
  if (error) return false;
  return data === true;
}

export async function resendConfirmation(email: string): Promise<AuthResult> {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
  record(error, 'Reenviar e-mail de confirmação');
  return { error: error ? msg(error) : null };
}

export async function resetPassword(email: string): Promise<AuthResult> {
  const redirectTo = makeRedirectUri({ scheme: APP_SCHEME, path: 'reset-password' });
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  record(error, 'Enviar link de recuperação de senha');
  return { error: error ? msg(error) : null };
}

export async function updatePassword(password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.updateUser({ password });
  record(error, 'Definir nova senha');
  return { error: error ? msg(error) : null };
}

export async function signInWithGoogle(): Promise<AuthResult & { cancelled?: boolean }> {
  try {
    const redirectTo = makeRedirectUri({ scheme: APP_SCHEME, path: 'auth-callback' });
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) {
      record(error, 'Entrar com Google');
      return { error: msg(error) };
    }
    if (!data?.url) return { error: 'Não foi possível iniciar o login com Google.' };

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') return { error: null, cancelled: true };

    const code = new URL(result.url).searchParams.get('code');
    if (!code) return { error: 'Resposta de login inválida.' };

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    record(exchangeError, 'Concluir login com Google');
    return { error: exchangeError ? msg(exchangeError) : null };
  } catch (e) {
    record(e, 'Entrar com Google');
    return { error: msg(e) };
  }
}
