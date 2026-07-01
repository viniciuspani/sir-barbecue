import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { categoryRepository, productRepository } from '@/data/repositories';
import type { Category } from '@/domain/entities/Category';
import type { Product } from '@/domain/entities/Product';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL } from '@/lib/currency';

export default function ProdutosList() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    const unsubProducts = productRepository.observeAll(setProducts);
    const unsubCategories = categoryRepository.observeAll(setCategories);
    return () => {
      unsubProducts();
      unsubCategories();
    };
  }, []);

  const categoryName = (id?: string) =>
    categories.find((c) => c.id === id)?.name ?? 'Sem categoria';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Produtos</Text>
        <Text style={styles.count}>{products.length} item(ns)</Text>
      </View>

      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>Nenhum produto ainda. Toque em “+” para cadastrar.</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, !item.isActive && styles.rowInactive]}
            onPress={() => router.push({ pathname: '/produtos/form', params: { id: item.id } })}
            accessibilityRole="button"
            accessibilityLabel={`Editar ${item.name}`}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.meta}>
                {categoryName(item.categoryId)}
                {item.isActive ? '' : ' · Inativo'}
              </Text>
            </View>
            <Text style={styles.price}>{formatBRL(item.price)}</Text>
          </Pressable>
        )}
      />

      <Pressable
        style={styles.fab}
        onPress={() => router.push('/produtos/form')}
        accessibilityRole="button"
        accessibilityLabel="Novo produto"
      >
        <Ionicons name="add" size={28} color={colors.onGold} />
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
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
  rowInactive: { opacity: 0.5 },
  rowMain: { flex: 1, marginRight: spacing.md },
  name: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  price: { color: colors.gold, fontSize: 16, fontWeight: '700' },
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
