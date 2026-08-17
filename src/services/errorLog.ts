import { and, desc, eq, lt, notInArray } from 'drizzle-orm';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import { db } from '@/data/local/database';
import { errorLogs } from '@/data/local/schema';
import { normalizeError, redact } from '@/lib/errors';
import { getBreadcrumbs, getCurrentScreen } from '@/services/breadcrumbs';
import { useAuthStore } from '@/store/authStore';
import { useConnectivityStore } from '@/store/connectivityStore';

/**
 * Registro de erros — grava LOCAL primeiro (SQLite) e o sync sobe depois.
 *
 * O app é offline-first: o erro que mais importa é justamente o que acontece sem
 * internet. Por isso nada aqui depende de rede. O `refCode` devolvido é o código
 * curto mostrado ao usuário no alerta e é o que localiza o registro no painel.
 *
 * REGRA DE OURO: este módulo NUNCA lança. Uma falha ao registrar o erro não pode
 * virar um segundo erro (nem derrubar a tela que já estava em apuros).
 */

export type Severity = 'error' | 'fatal';

export type LogOptions = {
  /** O que o usuário estava fazendo (ex.: "Fechar venda"). */
  action?: string;
  /** Rota; se omitida, usa a tela atual da trilha de navegação. */
  screen?: string;
  severity?: Severity;
  /** Mensagem exibida ao usuário — guardada para o suporte saber o que ele viu. */
  userMessage?: string;
  /** Dados extras da tela (IDs, filtros). Não inclua dado sensível. */
  meta?: Record<string, unknown>;
  /**
   * Janela de deduplicação para ESTE erro. Rotinas que repetem em intervalo fixo
   * (o sync roda a cada 5 min) precisam de uma janela larga, senão um servidor
   * fora do ar geraria centenas de linhas idênticas por dia.
   */
  dedupeMs?: number;
};

// Sem 0/O/1/I: o código é ditado por telefone pelo cliente ao suporte.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

const MAX_ROWS = 500; // teto local: o log jamais pode inchar o banco do PDV
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const PRUNE_EVERY = 25; // poda a cada N gravações (não a cada uma)
const DEDUPE_WINDOW_MS = 3000; // erro idêntico em rajada (loop de render) grava 1x
const DEDUPE_MAX_KEYS = 100; // teto do mapa de deduplicação (não é cache, é anti-rajada)

let writeCount = 0;
// Assinatura do erro → última gravação. Evita encher o log com linhas idênticas
// sem descartar erros DIFERENTES que aconteçam ao mesmo tempo (uma tela que
// carrega 5 consultas em paralelo pode falhar em todas — e as 5 importam).
const recent = new Map<string, { at: number; refCode: string }>();

function newRefCode(): string {
  const bytes = Crypto.getRandomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function safeJson(value: unknown): string | null {
  try {
    return redact(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * Grava o erro e devolve o código de referência.
 * Resolve mesmo se a gravação falhar — o código sempre volta para o alerta.
 */
export async function logError(error: unknown, options: LogOptions = {}): Promise<string> {
  const refCode = newRefCode();
  try {
    const { message, detail } = normalizeError(error);
    const action = options.action ?? null;

    // Rajada do MESMO erro (efeito que re-renderiza, sync repetindo a cada ciclo):
    // reaproveita o código anterior em vez de encher o log com linhas iguais.
    const signature = `${action ?? ''}|${message}`;
    const now = Date.now();
    const seen = recent.get(signature);
    const window = options.dedupeMs ?? DEDUPE_WINDOW_MS;
    if (seen && now - seen.at < window) {
      seen.at = now;
      return seen.refCode;
    }
    if (recent.size >= DEDUPE_MAX_KEYS) recent.clear();
    recent.set(signature, { at: now, refCode });

    const auth = useAuthStore.getState();
    const context = safeJson({
      breadcrumbs: getBreadcrumbs(),
      isOnline: useConnectivityStore.getState().isOnline,
      role: auth.currentRole,
      membershipStatus: auth.membershipStatus,
      // Erro anterior ao login/vínculo: o push carimba tenant/usuário depois.
      preAuth: !auth.currentTenantId,
      meta: options.meta ?? null,
    });

    await db.insert(errorLogs).values({
      id: Crypto.randomUUID(),
      refCode,
      occurredAt: now,
      severity: options.severity ?? 'error',
      screen: options.screen ?? getCurrentScreen(),
      action,
      context,
      message,
      detail,
      userMessage: options.userMessage ?? null,
      userId: auth.user?.id ?? null,
      tenantId: auth.currentTenantId,
      appVersion: Application.nativeApplicationVersion ?? null,
      platform: Platform.OS,
      osVersion: String(Platform.Version),
      needsSync: true,
    });

    // Em dev, continua visível no console — o log em banco não substitui o debug.
    if (__DEV__) console.warn(`[erro ${refCode}] ${action ?? 'sem ação'} — ${message}`);

    if (++writeCount % PRUNE_EVERY === 0) await pruneErrorLogs();
  } catch (e) {
    // Último recurso: console. NÃO chamamos logError aqui — um erro sobre o erro
    // realimentaria a fila indefinidamente.
    console.warn('[errorLog] falha ao gravar o log', e);
  }
  return refCode;
}

/**
 * Poda o log local: remove o que já subiu e envelheceu, e depois corta o excesso
 * mantendo os mais recentes. Nunca apaga registro pendente de sync.
 */
export async function pruneErrorLogs(): Promise<void> {
  try {
    await db
      .delete(errorLogs)
      .where(and(eq(errorLogs.needsSync, false), lt(errorLogs.occurredAt, Date.now() - MAX_AGE_MS)));

    const keep = await db
      .select({ id: errorLogs.id })
      .from(errorLogs)
      .orderBy(desc(errorLogs.occurredAt))
      .limit(MAX_ROWS);
    if (keep.length < MAX_ROWS) return;
    await db.delete(errorLogs).where(
      and(
        eq(errorLogs.needsSync, false),
        notInArray(
          errorLogs.id,
          keep.map((r) => r.id),
        ),
      ),
    );
  } catch (e) {
    console.warn('[errorLog] falha ao podar o log', e);
  }
}
