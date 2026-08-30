import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { tabRepository } from '@/data/repositories';
import type { Tab } from '@/domain/entities/Tab';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { BrandLogo } from '@/ui/BrandLogo';

/** Há quanto tempo a comanda está aberta — "12 min", "1 h 20". */
function elapsedLabel(openedAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - openedAt) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

const TICK_MS = 60_000; // atualiza os tempos de tela em tela

/**
 * Fila de produção: todas as comandas abertas com os itens à vista.
 *
 * Existe porque quem está na churrasqueira precisa LER o que assar, não navegar.
 * As pastilhas da tela de Venda servem ao caixa (escolher destino), mas exigem
 * um toque por comanda para ver o pedido. Aqui tudo aparece de uma vez, e a lista
 * se atualiza sozinha: o observer local reage ao banco e o tempo real
 * (src/data/sync/tabsLive.ts) traz na hora o que foi lançado em OUTRO aparelho.
 *
 * Ordem: mais antiga primeiro, que é a ordem de atendimento.
 */
export default function Comandas() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [, setTick] = useState(0);

  useEffect(() => tabRepository.observeAll(setTabs), []);

  // Só para os rótulos de tempo não congelarem com a tela aberta na bancada.
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const tabTotal = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const tabCount = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BrandLogo style={styles.brand} />
      <View style={styles.header}>
        <Text style={styles.title}>Comandas</Text>
        <Text style={styles.count}>{tabs.length} aberta(s)</Text>
      </View>

      <FlatList
        data={tabs}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>Nenhuma comanda aberta. Abra uma na aba Venda.</Text>
        }
        renderItem={({ item: tab }) => (
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
            </View>
          </View>
        )}
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
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  customer: { flex: 1, color: colors.textPrimary, fontSize: 18, fontWeight: '700' },
  elapsedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  elapsed: { color: colors.textSecondary, fontSize: 13 },
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
});
