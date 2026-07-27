import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { productRepository, supplierRepository } from '@/data/repositories';
import type { ProductSupplierPriceHistory } from '@/domain/entities/ProductSupplierPriceHistory';
import type { Supplier } from '@/domain/entities/Supplier';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL } from '@/lib/currency';
import { formatDatePtBR } from '@/lib/dates';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';

const MAX_ITEMS = 15;

export default function HistoricoPreco() {
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  const [productName, setProductName] = useState('—');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  // Sempre carregado do mais novo para o mais antigo; o toggle abaixo só inverte em memória.
  const [history, setHistory] = useState<ProductSupplierPriceHistory[]>([]);
  // Fornecedores que AINDA são vínculo ativo do produto — para o selo "atual".
  const [activeSupplierIds, setActiveSupplierIds] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');

  useEffect(() => {
    if (!productId) return;
    productRepository
      .getById(productId)
      .then((p) => {
        if (p) setProductName(p.name);
      })
      .catch(() => undefined);
    supplierRepository.list().then(setSuppliers).catch(() => undefined);
    supplierRepository.listPriceHistory(productId, MAX_ITEMS).then(setHistory).catch(() => undefined);
    supplierRepository
      .listLinksByProduct(productId)
      .then((links) => setActiveSupplierIds(new Set(links.map((l) => l.supplierId))))
      .catch(() => undefined);
  }, [productId]);

  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? '—';

  const displayed = useMemo(
    () => (order === 'desc' ? history : [...history].reverse()),
    [history, order],
  );

  const { minPrice, maxPrice } = useMemo(() => {
    if (history.length === 0) return { minPrice: null, maxPrice: null };
    const values = history.map((h) => h.purchasePrice);
    return { minPrice: Math.min(...values), maxPrice: Math.max(...values) };
  }, [history]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <BrandLogo />
        <Text style={styles.title}>Histórico de preço de compra</Text>
        <Text style={styles.subtitle}>{productName}</Text>

        <View style={styles.orderRow}>
          <Chip label="Mais recente primeiro" selected={order === 'desc'} onPress={() => setOrder('desc')} />
          <Chip label="Mais antigo primeiro" selected={order === 'asc'} onPress={() => setOrder('asc')} />
        </View>
        <Text style={styles.hint}>
          {order === 'desc'
            ? 'Mostrando do mais recente para o mais antigo.'
            : 'Mostrando do mais antigo para o mais recente.'}
        </Text>

        {displayed.length === 0 && (
          <Text style={styles.hint}>Nenhuma mudança de preço registrada ainda.</Text>
        )}
        {displayed.map((h) => {
          const isMin = minPrice != null && h.purchasePrice === minPrice;
          const isMax = maxPrice != null && h.purchasePrice === maxPrice;
          const highlighted = minPrice !== maxPrice && (isMin || isMax);
          return (
            <View key={h.id} style={styles.row}>
              <View style={styles.rowMain}>
                <View style={styles.supplierRow}>
                  <Text style={styles.supplier}>{supplierName(h.supplierId)}</Text>
                  {activeSupplierIds.has(h.supplierId) && <Text style={styles.badgeAtual}>atual</Text>}
                </View>
                <Text style={styles.date}>{formatDatePtBR(new Date(h.recordedAt))}</Text>
              </View>
              <View style={styles.rowEnd}>
                <Text style={styles.price}>{formatBRL(h.purchasePrice)}</Text>
                {highlighted && (
                  <Text style={isMax ? styles.badgeMax : styles.badgeMin}>
                    {isMax ? 'maior' : 'menor'}
                  </Text>
                )}
              </View>
            </View>
          );
        })}

        <Button title="Voltar" variant="text" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginBottom: spacing.sm },
  orderRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  hint: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  rowMain: { flex: 1 },
  rowEnd: { alignItems: 'flex-end' },
  supplierRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badgeAtual: {
    color: colors.onGold,
    backgroundColor: colors.gold,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  supplier: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  date: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  price: { color: colors.gold, fontSize: 16, fontWeight: '700' },
  badgeMax: { color: colors.green, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  badgeMin: { color: colors.danger, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
});
