import { FunctionsHttpError } from '@supabase/supabase-js';

import { supabase } from '@/data/remote/supabaseClient';
import { logSilently } from '@/lib/feedback';
import { useAuthStore } from '@/store/authStore';

// Wrappers das Edge Functions (multi-tenant). O JWT da sessão é anexado automaticamente
// pelo supabase.functions.invoke — ele autentica QUEM chama; a empresa vai no corpo
// (ver activeTenantId abaixo).

/**
 * Empresa ativa na tela, para mandar no corpo da chamada.
 *
 * As functions têm dois caminhos: com `tenant_id` no corpo elas VALIDAM a
 * associação contra `user_tenant_ids()` e usam exatamente essa empresa; sem ele,
 * caem num fallback que escolhe uma empresa ARBITRÁRIA — `app_metadata.tenant_ids[0]`
 * ou `select tenant_id from tenant_members limit 1`, nenhum dos dois com ordenação.
 * Enquanto cada usuário pertence a uma só empresa dá no mesmo; no dia em que
 * alguém pertencer a duas, o relatório pode sair da empresa errada.
 *
 * Null → o campo é OMITIDO (não enviado como null): sem empresa resolvida, o
 * fallback do servidor ainda é o melhor palpite disponível.
 */
function activeTenantId(): string | null {
  return useAuthStore.getState().currentTenantId;
}

/** Espalha `tenant_id` no corpo só quando há empresa ativa. */
function withTenant(body: Record<string, unknown>): Record<string, unknown> {
  const tenantId = activeTenantId();
  return tenantId ? { ...body, tenant_id: tenantId } : body;
}

async function callFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  // A tela decide como avisar o usuário (cada uma já trata o `error` retornado);
  // aqui garantimos que a causa técnica não se perca.
  const record = (cause: unknown) =>
    logSilently(cause, { action: `Chamar serviço "${name}"`, screen: 'edge-function' });

  // As functions pararam de devolver a mensagem crua da exceção (nome de tabela,
  // constraint, policy) e passaram a mandar uma frase genérica + `ref`, com o
  // detalhe técnico no log da função. O código de referência é o que liga o que
  // o usuário vê ao que o suporte consegue procurar — então ele entra na
  // mensagem. Ver A10-01 na auditoria de segurança.
  const withRef = (message: string, ref?: string) => (ref ? `${message} (cód. ${ref})` : message);

  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // FunctionsHttpError (status != 2xx): tenta extrair a mensagem do corpo { error }.
    if (error instanceof FunctionsHttpError) {
      const parsed = (await (error.context as Response).json().catch(() => null)) as {
        error?: string;
        ref?: string;
      } | null;
      record({ message: parsed?.error ?? error.message, name: 'FunctionsHttpError' });
      return {
        data: null,
        error: withRef(parsed?.error ?? 'Falha na função.', parsed?.ref),
      };
    }
    record(error);
    return { data: null, error: error.message };
  }
  const payload = data as { error?: string; ref?: string } | null;
  if (payload?.error) {
    record({ message: payload.error, name: 'FunctionError' });
    return { data: null, error: withRef(payload.error, payload.ref) };
  }
  return { data: data as T, error: null };
}

export async function generateReport(input: {
  type?: string;
  from?: string;
  to?: string;
}): Promise<{ path: string | null; error: string | null }> {
  const { data, error } = await callFunction<{ path?: string }>('generate-report', withTenant(input));
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
  const { data, error } = await callFunction<{ invited?: boolean }>(
    'invite-member',
    withTenant({ email, role }),
  );
  return { error, invited: data?.invited ?? false };
}

/**
 * Exclusão definitiva da conta e da empresa. Ter a sessão do aparelho não basta:
 * a função exige uma prova antes de apagar qualquer coisa — ver A06-03 na
 * auditoria de segurança (docs/auditoria-seguranca-web).
 *
 * Qual prova depende de como a conta foi criada (ver `usesPasswordLogin`):
 * conta com senha manda `password`, conta do Google manda `confirmText` com o
 * próprio e-mail — quem entrou pelo Google não tem senha no GoTrue para validar.
 */
export async function deleteAccount(proof: {
  password?: string;
  confirmText?: string;
}): Promise<{ error: string | null }> {
  const { error } = await callFunction('delete-account', proof);
  return { error };
}
