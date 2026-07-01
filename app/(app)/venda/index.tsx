import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { categoryRepository, productRepository, stockRepository } from '@/data/repositories';
import type { Category } from '@/domain/entities/Category';
import type { Product } from '@/domain/entities/Product';
import type { StockItem } from '@/domain/entities/StockItem';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { showToast } from '@/lib/toast';
import { useCartStore } from '@/store/cartStore';
import { Chip } from '@/ui/Chip';

// RF-05: produto aparece na venda se ativo e visível no dia da semana atual.
function isVisibleToday(p: Product, weekday: number): boolean {
  return !p.visibleDays || p.visibleDays.length === 0 || p.visibleDays.includes(weekday);
}

export default function NovaVenda() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null); // null = todas

  const items = useCartStore((s) => s.items);
  const add = useCartStore((s) => s.add);
  const total = useCartStore((s) => s.total);
  const count = useCartStore((s) => s.count);

  useEffect(() => {
    const unsubProducts = productRepository.observeAll(setProducts);
    const unsubCategories = categoryRepository.observeAll(setCategories);
    const unsubStock = stockRepository.observeItems(setStock);
    return () => {
      unsubProducts();
      unsubCategories();
      unsubStock();
    };
  }, []);

  const weekday = new Date().getDay();
  const visible = useMemo(
    () => products.filter((p) => p.isActive && isVisibleToday(p, weekday)),
    [products, weekday],
  );
  const filtered = categoryId ? visible.filter((p) => p.categoryId === categoryId) : visible;

  const qtyInCart = (id: string) => items.find((i) => i.productId === id)?.quantity ?? 0;
  const stockQty = (id: string) => stock.find((s) => s.productId === id)?.quantity ?? 0;

  // RF-10: não permite vender sem saldo (considera o que já está no carrinho).
  const onAdd = (p: Product) => {
    const available = stockQty(p.id) - qtyInCart(p.id);
    if (available <= 0) {
      showToast('Produto sem estoque disponível.');
      return;
    }
    add({ productId: p.id, name: p.name, unitPrice: p.price });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Text style={styles.title}>Nova Venda</Text>

      <View style={styles.filtersWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          <Chip label="Todas" selected={categoryId === null} onPress={() => setCategoryId(null)} />
          {categories.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              selected={categoryId === c.id}
              onPress={() => setCategoryId(c.id)}
            />
          ))}
        </ScrollView>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(p) => p.id}
        numColumns={2}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.grid}
        ListEmptyComponent={<Text style={styles.empty}>Nenhum produto disponível hoje.</Text>}
        renderItem={({ item }) => {
          const inCart = qtyInCart(item.id);
          const sQty = stockQty(item.id);
          const out = sQty - inCart <= 0;
          return (
            <Pressable
              style={[styles.card, out && styles.cardOut]}
              onPress={() => onAdd(item)}
              accessibilityRole="button"
              accessibilityLabel={`Adicionar ${item.name}`}
            >
              {inCart > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{inCart}</Text>
                </View>
              )}
              <Text style={styles.cardName} numberOfLines={2}>
                {item.name}
              </Text>
              <Text style={styles.cardPrice}>{formatBRL(item.price)}</Text>
              <Text style={[styles.cardStock, sQty <= 0 && styles.cardStockOut]}>
                {sQty <= 0 ? 'Sem estoque' : `Estoque: ${formatQuantity(sQty)}`}
              </Text>
            </Pressable>
          );
        }}
      />

      {count() > 0 && (
        <Pressable
          style={styles.cartBar}
          onPress={() => router.push('/venda/fechar')}
          accessibilityRole="button"
        >
          <Text style={styles.cartBarText}>{count()} item(ns)</Text>
          <Text style={styles.cartBarCta}>Fechar · {formatBRL(total())}</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  title: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  filtersWrap: { paddingVertical: spacing.sm },
  filters: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  grid: { paddingHorizontal: spacing.lg, paddingBottom: 88, gap: spacing.sm },
  gridRow: { gap: spacing.sm },
  empty: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', marginTop: spacing.xxl },
  card: {
    flex: 1,
    minHeight: 104,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    justifyContent: 'space-between',
  },
  cardOut: { opacity: 0.55 },
  badge: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: colors.onGold, fontSize: 12, fontWeight: '700' },
  cardName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  cardPrice: { color: colors.gold, fontSize: 15, fontWeight: '700', marginTop: spacing.sm },
  cardStock: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  cardStockOut: { color: colors.yellow, fontWeight: '600' },
  cartBar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.red,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  cartBarText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  cartBarCta: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
});
