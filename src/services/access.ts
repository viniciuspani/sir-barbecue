import * as Application from 'expo-application';
import { Platform } from 'react-native';

import { supabase } from '@/data/remote/supabaseClient';
import { secureStorage } from '@/services/secureStorage';

/**
 * Controle de acesso dirigido pela ASSINATURA da empresa (trial → pago).
 *
 * A decisão é 100% do servidor (RPC get_access_status) — à prova de manipulação
 * de relógio. O app apenas reflete o veredito, com cache seguro para o caso offline:
 *   - último veredito "bloqueado"  → permanece bloqueado offline;
 *   - último veredito "liberado"   → concede uma janela de graça (GRACE_MS);
 *   - sem histórico + offline       → concede o benefício da dúvida (não trava
 *                                      cliente legítimo no primeiro uso sem rede).
 */

export type AccessReason =
  | 'trial'
  | 'active'
  | 'trial_expired'
  | 'payment_overdue'
  | 'canceled'
  | 'blocked_by_owner'
  | 'no_subscription'
  | 'no_tenant'
  | 'forbidden'
  | 'unknown'
  | 'unverified';

export type AccessVerdict = {
  allowed: boolean;
  reason: AccessReason | null;
  endsAt: string | null;
  daysRemaining: number;
};

const CACHE_PREFIX = 'access.cache.v1.';
const RPC_TIMEOUT_MS = 6000;
const GRACE_MS = 72 * 60 * 60 * 1000; // 72h de graça offline quando o último veredito era "liberado"

/** Bypass de desenvolvimento: EXPO_PUBLIC_ACCESS_BYPASS=true desliga o gate. */
export function isAccessEnforced(): boolean {
  return process.env.EXPO_PUBLIC_ACCESS_BYPASS !== 'true';
}

type Cached = AccessVerdict & { cachedAt: number };

async function readCache(tenantId: string): Promise<Cached | null> {
  const raw = await secureStorage.get(CACHE_PREFIX + tenantId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Cached;
  } catch {
    return null;
  }
}

async function writeCache(tenantId: string, verdict: AccessVerdict): Promise<void> {
  const payload: Cached = { ...verdict, cachedAt: Date.now() };
  await secureStorage.set(CACHE_PREFIX + tenantId, JSON.stringify(payload));
}

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function normalize(data: unknown): AccessVerdict {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    allowed: d.allowed === true,
    reason: (d.reason as AccessReason | null) ?? null,
    endsAt: (d.endsAt as string | null) ?? null,
    daysRemaining: typeof d.daysRemaining === 'number' ? d.daysRemaining : 0,
  };
}

/** Consulta o servidor (fonte da verdade). Cai para cache/graça se offline. */
export async function evaluateAccess(tenantId: string): Promise<AccessVerdict> {
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('get_access_status', { p_tenant_id: tenantId }),
      RPC_TIMEOUT_MS,
    );
    if (error) throw error;
    const verdict = normalize(data);
    await writeCache(tenantId, verdict);
    return verdict;
  } catch {
    const cached = await readCache(tenantId);
    if (!cached) {
      return { allowed: true, reason: 'unverified', endsAt: null, daysRemaining: 0 };
    }
    if (!cached.allowed) {
      return { allowed: false, reason: cached.reason, endsAt: cached.endsAt, daysRemaining: 0 };
    }
    const withinGrace = Date.now() - cached.cachedAt < GRACE_MS;
    return withinGrace
      ? {
          allowed: true,
          reason: cached.reason,
          endsAt: cached.endsAt,
          daysRemaining: cached.daysRemaining,
        }
      : { allowed: false, reason: 'unverified', endsAt: cached.endsAt, daysRemaining: 0 };
  }
}

/** Identificador estável do aparelho (sobrevive à reinstalação no Android). */
export async function getDeviceId(): Promise<string | null> {
  try {
    if (Platform.OS === 'android') return Application.getAndroidId();
    return await Application.getIosIdForVendorAsync();
  } catch {
    return null;
  }
}

/** Vincula o aparelho à empresa (idempotente no servidor). Best-effort. */
export async function bindDevice(tenantId: string): Promise<void> {
  const deviceId = await getDeviceId();
  if (!deviceId) return;
  try {
    await supabase.rpc('bind_device', {
      p_device_id: deviceId,
      p_platform: Platform.OS,
      p_tenant_id: tenantId,
    });
  } catch {
    // Falha de vínculo não deve bloquear o app.
  }
}
