import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { kitchenTicketRepository, tabRepository } from '@/data/repositories';
import type { KitchenTicket } from '@/domain/entities/KitchenTicket';
import type { Tab } from '@/domain/entities/Tab';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { BrandLogo } from '@/ui/BrandLogo';

/** Há quanto tempo — "12 min", "1 h 20". */
function elapsedLabel(since: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - since) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

const TICK_MS = 60_000; // atualiza os tempos de tela em tela

// SectionList precisa de um item por linha; as duas seções têm tipos
// diferentes (ticket de cozinha × comanda), então cada linha carrega o seu.
type Row = { kind: 'ticket'; ticket: KitchenTicket } | { kind: 'tab'; tab: Tab };

/**
 * Duas listas independentes (MIGRATION_29 — "ticket de cozinha" desacoplado
 * da comanda):
 *
 *  • NA CHURRASQUEIRA — tickets de cozinha PRÉ-PAGOS, um por RODADA de
 *    pedido (não por comanda: o mesmo cliente pedindo de novo gera outro
 *    ticket, a comanda dele continua aberta e aparece nas duas listas ao
 *    mesmo tempo). O relógio conta desde o PAGAMENTO: o cliente já pagou e
 *    está esperando de pé.
 *  • EM ABERTO — comandas de consumo (pagam no fim, ou continuam abertas pra
 *    receber o próximo pedido). Só sai daqui quando o operador encerra de
 *    propósito.
 *
 * Esta tela é lida na bancada, não navegada: o item aparece inteiro, a
 * quantidade vem antes do nome e em caixa grande — é o que a churrasqueira lê
 * de longe para saber quantos espetos pôr na grelha. A lista se atualiza
 * sozinha: o observer local reage ao banco e o tempo real
 * (src/data/sync/tabsLive.ts) traz na hora o que foi lançado em OUTRO aparelho,
 * que é como o pedido pago no caixa chega ao celular do churrasqueiro.
 *
 * Ordem dentro de cada seção: mais antiga primeiro, que é a ordem de atendimento.
 */
export default function Comandas() {
  const [queue, setQueue] = useState<KitchenTicket[]>([]);
  const [open, setOpen] = useState<Tab[]>([]);
  const [, setTick] = useState(0);
  const { readOnlyReason } = usePermissions();

  useEffect(() => kitchenTicketRepository.observeQueue(setQueue), []);
  useEffect(() => tabRepository.observeAll(setOpen), []);

  // Só para os rótulos de tempo não congelarem com a tela aberta na bancada.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const tabTotal = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const tabCount = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.quantity, 0);
  const ticketCount = (t: KitchenTicket) => t.items.reduce((sum, i) => sum + i.quantity, 0);

  const guard = (run: () => void) => () => {
    if (readOnlyReason) {
      showToast(readOnlyReason);
      return;
    }
    run();
  };

  const onDeliver = (ticket: KitchenTicket) =>
    Alert.alert('Entregar pedido', `Entregar o pedido de ${ticket.customerName}?`, [
      { text: 'Voltar', style: 'cancel' },
      { text: 'Entregue', onPress: () => kitchenTicketRepository.markDelivered(ticket.id) },
    ]);

  const onClose = (tab: Tab) => {
    if (tab.items.length > 0) {
      showToast('Ainda tem item não pago nesta comanda.');
      return;
    }
    Alert.alert('Encerrar comanda', `Encerrar a comanda de ${tab.customerName}?`, [
      { text: 'Voltar', style: 'cancel' },
      { text: 'Encerrar', onPress: () => tabRepository.close(tab.id) },
    ]);
  };

  const sections = [
    {
      key: 'queue' as const,
      title: 'Na churrasqueira',
      data: queue.map((ticket): Row => ({ kind: 'ticket', ticket })),
    },
    { key: 'open' as const, title: 'Em aberto', data: open.map((tab): Row => ({ kind: 'tab', tab })) },
  ].filter((s) => s.data.length > 0);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BrandLogo style={styles.brand} />
      <View style={styles.header}>
        <Text style={styles.title}>Comandas</Text>
        <Text style={styles.count}>
          {queue.length} na churrasqueira · {open.length} aberta(s)
        </Text>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(row) => (row.kind === 'ticket' ? row.ticket.id : row.tab.id)}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text style={styles.empty}>Nenhuma comanda. Abra uma na aba Venda.</Text>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item }) =>
          item.kind === 'ticket' ? (
            <TicketCard
              ticket={item.ticket}
              count={ticketCount(item.ticket)}
              onReady={guard(() => kitchenTicketRepository.markReady(item.ticket.id))}
              onDeliver={guard(() => onDeliver(item.ticket))}
            />
          ) : (
            <OpenTabCard
              tab={item.tab}
              count={tabCount(item.tab)}
              total={tabTotal(item.tab)}
              onClose={guard(() => onClose(item.tab))}
            />
          )
        }
      />
    </SafeAreaView>
  );
}

function TicketCard({
  ticket,
  count,
  onReady,
  onDeliver,
}: {
  ticket: KitchenTicket;
  count: number;
  onReady: () => void;
  onDeliver: () => void;
}) {
  return (
    <View style={[styles.card, styles.cardQueue]}>
      <View style={styles.cardHeader}>
        <Text style={styles.customer} numberOfLines={1}>
          {ticket.customerName}
        </Text>
        {ticket.status === 'ready' && (
          <View style={styles.readyBadge}>
            <Text style={styles.readyBadgeText}>PRONTO</Text>
          </View>
        )}
        <View style={styles.elapsedRow}>
          <Ionicons name="flame-outline" size={14} color={colors.gold} />
          <Text style={[styles.elapsed, styles.elapsedQueue]}>{elapsedLabel(ticket.createdAt)}</Text>
        </View>
      </View>

      {ticket.items.length === 0 ? (
        <Text style={styles.hint}>Sem itens ainda.</Text>
      ) : (
        <View style={styles.items}>
          {ticket.items.map((line, index) => (
            <View key={index} style={styles.itemRow}>
              {/* Quantidade primeiro e grande: é o que a churrasqueira lê de
                  longe para saber quantos espetos pôr na grelha. */}
              <View style={styles.qtyBox}>
                <Text style={styles.qtyText}>{formatQuantity(line.quantity)}</Text>
              </View>
              <Text style={styles.itemName} numberOfLines={1}>
                {line.name}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.cardFooter}>
        <Text style={styles.footerInfo}>{count} item(ns) · pago</Text>
        <View style={styles.actions}>
          {/* "Pronto" é opcional: no pico, um toque a menos vale mais que o
              rastro, então "Entregue" já está aqui desde 'pending'. */}
          {ticket.status === 'pending' && (
            <Pressable
              onPress={onReady}
              accessibilityRole="button"
              accessibilityLabel={`Marcar o pedido de ${ticket.customerName} como pronto`}
              hitSlop={8}
              style={styles.actionGhost}
            >
              <Text style={styles.actionGhostText}>Pronto</Text>
            </Pressable>
          )}
          <Pressable
            onPress={onDeliver}
            accessibilityRole="button"
            accessibilityLabel={`Entregar o pedido de ${ticket.customerName}`}
            hitSlop={8}
            style={styles.actionPrimary}
          >
            <Text style={styles.actionPrimaryText}>Entregue</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function OpenTabCard({
  tab,
  count,
  total,
  onClose,
}: {
  tab: Tab;
  count: number;
  total: number;
  onClose: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.customer} numberOfLines={1}>
          {tab.customerName}
        </Text>
        <View style={styles.elapsedRow}>
          <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.elapsed}>{elapsedLabel(tab.openedAt)}</Text>
        </View>
      </View>

      {tab.items.length === 0 ? (
        <Text style={styles.hint}>Sem itens ainda.</Text>
      ) : (
        <View style={styles.items}>
          {tab.items.map((line) => (
            <View key={line.id} style={styles.itemRow}>
              <View style={styles.qtyBox}>
                <Text style={styles.qtyText}>{formatQuantity(line.quantity)}</Text>
              </View>
              <Text style={styles.itemName} numberOfLines={1}>
                {line.name}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.cardFooter}>
        <Text style={styles.footerInfo}>
          {count} item(ns) · {formatBRL(total)}
        </Text>
        <View style={styles.actions}>
          {tab.items.length === 0 && (
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={`Encerrar a comanda de ${tab.customerName}`}
              hitSlop={8}
            >
              <Text style={styles.footerActionMuted}>Encerrar comanda</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => router.push('/venda')}
            accessibilityRole="button"
            accessibilityLabel={`Lançar itens na comanda de ${tab.customerName}`}
            hitSlop={8}
          >
            <Text style={styles.footerAction}>Lançar itens</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  brand: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700' },
  count: { color: colors.textSecondary, fontSize: 14 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  empty: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', marginTop: spacing.xxl },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: spacing.sm,
  },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  // A faixa dourada separa, de relance, o pedido JÁ PAGO que está na grelha da
  // comanda que ainda vai pagar — confundir os dois custa uma cobrança a mais.
  cardQueue: { borderLeftWidth: 4, borderLeftColor: colors.gold },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  customer: { flex: 1, color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  readyBadge: {
    backgroundColor: colors.gold,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  readyBadgeText: { color: colors.onGold, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  elapsedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  elapsed: { color: colors.textSecondary, fontSize: 13 },
  elapsedQueue: { color: colors.gold, fontWeight: '600' },
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.sm },
  items: { marginTop: spacing.md, gap: spacing.sm },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  qtyBox: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyText: { color: colors.onGold, fontSize: 16, fontWeight: '700' },
  itemName: { flex: 1, color: colors.textPrimary, fontSize: 16 },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  footerInfo: { color: colors.textSecondary, fontSize: 13 },
  footerAction: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  footerActionMuted: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  // Alvos generosos: quem toca aqui está de luva, com a mão ocupada na grelha.
  actionGhost: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.gold,
  },
  actionGhostText: { color: colors.gold, fontSize: 14, fontWeight: '700' },
  actionPrimary: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.sm,
    backgroundColor: colors.gold,
  },
  actionPrimaryText: { color: colors.onGold, fontSize: 14, fontWeight: '700' },
});
