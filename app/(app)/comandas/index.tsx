import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { tabRepository } from '@/data/repositories';
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

/**
 * Duas listas que parecem uma só, porque para quem está no balcão são dois
 * momentos do mesmo atendimento:
 *
 *  • NA CHURRASQUEIRA — pedidos PRÉ-PAGOS. No pico de movimento a atendente
 *    cobra antes de o pedido ser produzido, para não perder o pagamento
 *    enquanto a fila cresce. Estes vêm primeiro porque são os que estão na
 *    grelha agora, e o relógio deles conta desde o PAGAMENTO: o cliente já
 *    pagou e está esperando de pé.
 *  • EM ABERTO — comandas de consumo, que pagam no fim (fluxo de sempre).
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
  const [queue, setQueue] = useState<Tab[]>([]);
  const [open, setOpen] = useState<Tab[]>([]);
  const [, setTick] = useState(0);
  const { readOnlyReason } = usePermissions();

  useEffect(() => tabRepository.observeQueue(setQueue), []);
  useEffect(() => tabRepository.observeAll(setOpen), []);

  // Só para os rótulos de tempo não congelarem com a tela aberta na bancada.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const tabTotal = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const tabCount = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.quantity, 0);

  const guard = (run: () => void) => () => {
    if (readOnlyReason) {
      showToast(readOnlyReason);
      return;
    }
    run();
  };

  const onDeliver = (tab: Tab) =>
    Alert.alert('Entregar pedido', `Entregar o pedido de ${tab.customerName}?`, [
      { text: 'Voltar', style: 'cancel' },
      { text: 'Entregue', onPress: () => tabRepository.markDelivered(tab.id) },
    ]);

  const sections = [
    { key: 'queue' as const, title: 'Na churrasqueira', data: queue },
    { key: 'open' as const, title: 'Em aberto', data: open },
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
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text style={styles.empty}>Nenhuma comanda. Abra uma na aba Venda.</Text>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionTitle}>{section.title}</Text>
        )}
        renderItem={({ item: tab, section }) => {
          const inQueue = section.key === 'queue';
          return (
            <View style={[styles.card, inQueue && styles.cardQueue]}>
              <View style={styles.cardHeader}>
                <Text style={styles.customer} numberOfLines={1}>
                  {tab.customerName}
                </Text>
                {tab.status === 'ready' && (
                  <View style={styles.readyBadge}>
                    <Text style={styles.readyBadgeText}>PRONTO</Text>
                  </View>
                )}
                <View style={styles.elapsedRow}>
                  <Ionicons
                    name={inQueue ? 'flame-outline' : 'time-outline'}
                    size={14}
                    color={inQueue ? colors.gold : colors.textSecondary}
                  />
                  <Text style={[styles.elapsed, inQueue && styles.elapsedQueue]}>
                    {elapsedLabel(inQueue ? (tab.paidAt ?? tab.openedAt) : tab.openedAt)}
                  </Text>
                </View>
              </View>

              {tab.items.length === 0 ? (
                <Text style={styles.hint}>Sem itens ainda.</Text>
              ) : (
                <View style={styles.items}>
                  {tab.items.map((line) => (
                    <View key={line.id} style={styles.itemRow}>
                      {/* Quantidade primeiro e grande: é o que a churrasqueira lê
                          de longe para saber quantos espetos pôr na grelha. */}
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
                {inQueue ? (
                  <>
                    <Text style={styles.footerInfo}>{tabCount(tab)} item(ns) · pago</Text>
                    <View style={styles.actions}>
                      {/* "Pronto" é opcional: no pico, um toque a menos vale mais
                          que o rastro, então "Entregue" já está aqui desde 'paid'. */}
                      {tab.status === 'paid' && (
                        <Pressable
                          onPress={guard(() => tabRepository.markReady(tab.id))}
                          accessibilityRole="button"
                          accessibilityLabel={`Marcar o pedido de ${tab.customerName} como pronto`}
                          hitSlop={8}
                          style={styles.actionGhost}
                        >
                          <Text style={styles.actionGhostText}>Pronto</Text>
                        </Pressable>
                      )}
                      <Pressable
                        onPress={guard(() => onDeliver(tab))}
                        accessibilityRole="button"
                        accessibilityLabel={`Entregar o pedido de ${tab.customerName}`}
                        hitSlop={8}
                        style={styles.actionPrimary}
                      >
                        <Text style={styles.actionPrimaryText}>Entregue</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.footerInfo}>
                      {tabCount(tab)} item(ns) · {formatBRL(tabTotal(tab))}
                    </Text>
                    <Pressable
                      onPress={() => router.push('/venda')}
                      accessibilityRole="button"
                      accessibilityLabel={`Lançar itens na comanda de ${tab.customerName}`}
                      hitSlop={8}
                    >
                      <Text style={styles.footerAction}>Lançar itens</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
