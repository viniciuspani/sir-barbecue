import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { productRepository, stockRepository } from '@/data/repositories';
import type { Product } from '@/domain/entities/Product';
import type { StockItem } from '@/domain/entities/StockItem';
import { colors, radii, spacing } from '@/design/tokens';
import { formatQuantity } from '@/lib/currency';
import { BrandLogo } from '@/ui/BrandLogo';

function isLow(item: StockItem): boolean {
  return item.alertThreshold > 0 && item.quantity <= item.alertThreshold;
}

export default function EstoqueList() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    const unsubItems = stockRepository.observeItems(setItems);
    const unsubProducts = productRepository.observeAll(setProducts);
    return () => {
      unsubItems();
      unsubProducts();
    };
  }, []);

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? '—';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <BrandLogo style={styles.brand} />
      <View style={styles.header}>
        <Text style={styles.title}>Estoque</Text>
        <Text style={styles.count}>{items.length} item(ns)</Text>
      </View>

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nenhum item em estoque. Toque em “+” para registrar uma entrada.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              router.push({ pathname: '/estoque/detalhe', params: { productId: item.productId } })
            }
            accessibilityRole="button"
            accessibilityLabel={`Detalhes de ${productName(item.productId)}`}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name}>{productName(item.productId)}</Text>
              {isLow(item) && <Text style={styles.lowBadge}>Estoque baixo</Text>}
            </View>
            <Text style={[styles.qty, isLow(item) && styles.qtyLow]}>
              {formatQuantity(item.quantity)}
            </Text>
          </Pressable>
        )}
      />

      <Pressable
        style={styles.fab}
        onPress={() => router.push('/estoque/entrada')}
        accessibilityRole="button"
        accessibilityLabel="Registrar entrada"
      >
        <Ionicons name="add" size={28} color={colors.onGold} />
      </Pressable>
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
  list: { paddingHorizontal: spacing.lg, paddingBottom: 96, gap: spacing.sm },
  empty: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', marginTop: spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  rowMain: { flex: 1, marginRight: spacing.md },
  name: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  lowBadge: { color: colors.yellow, fontSize: 13, fontWeight: '600', marginTop: 2 },
  qty: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
  qtyLow: { color: colors.yellow },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
});
