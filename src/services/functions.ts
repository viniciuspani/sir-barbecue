import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/data/remote/supabaseClient';

// Wrappers das Edge Functions (multi-tenant). O JWT da sessão é anexado automaticamente
// pelo supabase.functions.invoke — as functions resolvem o tenant pelo token.

async function callFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // FunctionsHttpError (status != 2xx): tenta extrair a mensagem do corpo { error }.
    if (error instanceof FunctionsHttpError) {
      const parsed = (await (error.context as Response).json().catch(() => null)) as
        | { error?: string }
        | null;
      return { data: null, error: parsed?.error ?? 'Falha na função.' };
    }
    return { data: null, error: error.message };
  }
  const payload = data as { error?: string } | null;
  if (payload?.error) return { data: null, error: payload.error };
  return { data: data as T, error: null };
}

export async function generateReport(input: {
  type?: string;
  from?: string;
  to?: string;
}): Promise<{ path: string | null; error: string | null }> {
  const { data, error } = await callFunction<{ path?: string }>('generate-report', input);
  return { path: data?.path ?? null, error };
}

/** URL assinada (bucket privado) para abrir/baixar o relatório gerado. */
export async function getReportSignedUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from('reports').createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

export async function inviteMember(
  email: string,
  role: 'manager' | 'employee',
): Promise<{ error: string | null; invited: boolean }> {
  const { data, error } = await callFunction<{ invited?: boolean }>('invite-member', { email, role });
  return { error, invited: data?.invited ?? false };
}

export async function deleteAccount(): Promise<{ error: string | null }> {
  const { error } = await callFunction('delete-account', {});
  return { error };
}
