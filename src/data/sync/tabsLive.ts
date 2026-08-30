import { AppState, type AppStateStatus } from 'react-native';

import { supabase } from '@/data/remote/supabaseClient';
import { syncTabsNow } from '@/data/sync/syncEngine';
import { logSilently } from '@/lib/feedback';

/**
 * Comandas em TEMPO REAL no aparelho.
 *
 * Por que existe: a lista de comandas não é só do caixa — é a fila de produção.
 * Quem está na churrasqueira lê as comandas para saber o que assar. Depender do
 * ciclo de sync (5 min) significaria o pedido chegar à grelha minutos depois de
 * o cliente pedir, o que quebra o atendimento. Vale para PWA↔Android e também
 * entre dois Androids.
 *
 * Estratégia: assina as mudanças de `tabs`/`tab_items` no Postgres e, a cada
 * evento, puxa SÓ as comandas — não o sync inteiro, que é pesado e desnecessário
 * aqui. O ciclo de 5 minutos continua existindo como rede de segurança.
 */

// Fallback quando o socket não está conectado (rede instável, servidor de
// realtime fora). Curto o bastante para a churrasqueira não sentir, longo o
// bastante para não virar polling agressivo.
const FALLBACK_POLL_MS = 15_000;

export function startTabsLive(tenantId: string): () => void {
  let stopped = false;
  let connected = false;
  let channel: ReturnType<typeof supabase.channel> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const refresh = () => {
    if (stopped) return;
    syncTabsNow().catch((e) => logSilently(e, { action: 'Atualizar comandas em tempo real' }));
  };

  const subscribe = () => {
    if (stopped) return;
    channel = supabase
      .channel(`tabs:${tenantId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tabs' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tab_items' }, refresh)
      .subscribe((status) => {
        connected = status === 'SUBSCRIBED';
        // Ao (re)conectar, busca o que mudou enquanto o socket esteve fora.
        if (connected) refresh();
      });
  };

  const unsubscribe = () => {
    if (!channel) return;
    void supabase.removeChannel(channel);
    channel = null;
    connected = false;
  };

  subscribe();

  // Só busca por conta própria quando o tempo real NÃO está de pé.
  pollTimer = setInterval(() => {
    if (!connected) refresh();
  }, FALLBACK_POLL_MS);

  // O Android derruba sockets em segundo plano: ao voltar, refaz a assinatura e
  // atualiza na hora — senão o operador olharia uma lista congelada.
  const onAppState = (state: AppStateStatus) => {
    if (state !== 'active') return;
    unsubscribe();
    subscribe();
  };
  const appStateSub = AppState.addEventListener('change', onAppState);

  return () => {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    appStateSub.remove();
    unsubscribe();
  };
}
