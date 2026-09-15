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

export type DataExportRequest = {
  id: string;
  status: 'pending' | 'ready' | 'sent' | 'delivered' | 'failed';
  contactEmail: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
};

/**
 * SOLICITA uma cópia dos dados da empresa (MIGRATION_25). Só owner.
 *
 * Deixou de ser download síncrono: montar o zip, subir no Storage e baixar tudo
 * pelo 4G travava o aparelho e a janela da Edge Function. Agora entra na fila do
 * worker horário — o mesmo que executa as exclusões — e o arquivo chega por
 * e-mail. Idempotente: com uma solicitação na fila, devolve a existente
 * (`alreadyQueued: true`) em vez de gerar um segundo zip.
 */
export async function requestDataExport(): Promise<{
  data: { id: string; alreadyQueued: boolean; contactEmail: string | null } | null;
  error: string | null;
}> {
  const { data, error } = await supabase.rpc('request_data_export');
  if (error) {
    logSilently(error, { action: 'Solicitar a exportação de dados', screen: 'exportar-dados' });
    return { data: null, error: 'Não foi possível registrar a solicitação. Tente de novo.' };
  }
  const d = (data ?? {}) as { id?: string; alreadyQueued?: boolean; contactEmail?: string };
  return {
    data: {
      id: d.id ?? '',
      alreadyQueued: d.alreadyQueued === true,
      contactEmail: d.contactEmail ?? null,
    },
    error: null,
  };
}

/** Últimas solicitações de exportação da empresa, para a tela mostrar o status. */
export async function listDataExportRequests(): Promise<DataExportRequest[]> {
  const tenantId = activeTenantId();
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('data_exports')
    .select('id, status, contact_email, created_at, sent_at, delivered_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) {
    logSilently(error, { action: 'Carregar as solicitações de exportação', screen: 'exportar-dados' });
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    status: r.status as DataExportRequest['status'],
    contactEmail: (r.contact_email as string | null) ?? null,
    createdAt: r.created_at as string,
    sentAt: (r.sent_at as string | null) ?? null,
    deliveredAt: (r.delivered_at as string | null) ?? null,
  }));
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

export type DeletionScheduled = {
  scheduled: boolean;
  deleted: boolean;
  scheduledFor: string | null;
  exportRequested: boolean;
};

/**
 * SOLICITA a exclusão da conta. Desde a MIGRATION_24 ela não apaga nada na hora
 * quando quem chama é DONO: grava uma solicitação com data marcada (48h sem
 * exportação, 10 dias úteis com) e a empresa entra em somente-leitura. Quem é
 * apenas membro continua sendo excluído imediatamente (`deleted: true`).
 *
 * Ter a sessão do aparelho não basta: a função exige uma prova antes de gravar
 * qualquer coisa — ver A06-03 na auditoria (docs/auditoria-seguranca-web). Qual
 * prova depende de como a conta foi criada (ver `usesPasswordLogin`): conta com
 * senha manda `password`, conta do Google manda `confirmText` com o próprio
 * e-mail — quem entrou pelo Google não tem senha no GoTrue para validar.
 *
 * `localPending` é a contagem de linhas ainda não sincronizadas NESTE aparelho: a
 * função recusa (409) se vier > 0, porque agendar com venda presa no SQLite
 * destruiria essa venda sem ela nunca ter subido.
 */
export async function requestAccountDeletion(input: {
  password?: string;
  confirmText?: string;
  exportRequested: boolean;
  // Opcionais porque o servidor só os exige no caminho do DONO. Gerente,
  // funcionário e usuário órfão caem no caminho imediato, que não agenda nada e
  // portanto não tem para quem ligar.
  contactName?: string;
  contactPhone?: string;
  localPending: number;
}): Promise<{ data: DeletionScheduled | null; error: string | null }> {
  const { data, error } = await callFunction<DeletionScheduled>('delete-account', input);
  return { data, error };
}

/** Datas previstas das duas opções, calculadas no SERVIDOR (dias úteis + feriados). */
export async function getDeletionPreview(): Promise<{
  dateNoExport: string | null;
  dateWithExport: string | null;
  error: string | null;
}> {
  const { data, error } = await supabase.rpc('deletion_request_preview');
  if (error) {
    logSilently(error, { action: 'Calcular as datas da exclusão', screen: 'perfil' });
    return { dateNoExport: null, dateWithExport: null, error: 'Não foi possível calcular as datas.' };
  }
  const d = (data ?? {}) as { dateNoExport?: string; dateWithExport?: string };
  return {
    dateNoExport: d.dateNoExport ?? null,
    dateWithExport: d.dateWithExport ?? null,
    error: null,
  };
}
