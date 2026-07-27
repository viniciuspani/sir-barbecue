import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { productRepository, stockRepository, supplierRepository } from '@/data/repositories';
import type { ProductSupplier } from '@/domain/entities/ProductSupplier';
import type { StockEntry } from '@/domain/entities/StockEntry';
import type { Supplier } from '@/domain/entities/Supplier';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity, parseBRL } from '@/lib/currency';
import { formatDatePtBR } from '@/lib/dates';
import { showToast } from '@/lib/toast';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

// Mesma regra de desempate do costOf() em supabase/functions/generate-report:
// fornecedor preferido; sem preferido, o de menor preço de compra cadastrado.
function pickCurrentCost(links: ProductSupplier[]): ProductSupplier | null {
  if (links.length === 0) return null;
  const preferred = links.find((l) => l.isPreferred);
  if (preferred) return preferred;
  return links.reduce((min, l) => (l.purchasePrice < min.purchasePrice ? l : min));
}

export default function EstoqueDetalhe() {
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  const [productName, setProductName] = useState('—');
  const [quantity, setQuantity] = useState(0);
  const [threshold, setThreshold] = useState('');
  const [entries, setEntries] = useState<StockEntry[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierLinks, setSupplierLinks] = useState<ProductSupplier[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!productId) return;
    productRepository
      .getById(productId)
      .then((p) => {
        if (p) setProductName(p.name);
      })
      .catch(() => undefined);
    stockRepository
      .getItem(productId)
      .then((it) => {
        if (it) {
          setQuantity(it.quantity);
          setThreshold(it.alertThreshold > 0 ? String(it.alertThreshold) : '');
        }
      })
      .catch(() => undefined);
    stockRepository.listEntries(productId).then(setEntries).catch(() => undefined);
    supplierRepository.list().then(setSuppliers).catch(() => undefined);
    supplierRepository.listLinksByProduct(productId).then(setSupplierLinks).catch(() => undefined);
  }, [productId]);

  const currentCost = useMemo(() => pickCurrentCost(supplierLinks), [supplierLinks]);
  const currentSupplierName = currentCost
    ? (suppliers.find((s) => s.id === currentCost.supplierId)?.name ?? '—')
    : null;

  const { minQty, maxQty } = useMemo(() => {
    if (entries.length === 0) return { minQty: null, maxQty: null };
    const values = entries.map((e) => e.quantity);
    return { minQty: Math.min(...values), maxQty: Math.max(...values) };
  }, [entries]);

  const onSaveAlert = async () => {
    if (!productId) return;
    setSaving(true);
    await stockRepository.setAlertThreshold(productId, parseBRL(threshold));
    setSaving(false);
    showToast('Alerta atualizado! ✅');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandLogo />
        <Text style={styles.title}>{productName}</Text>

        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Saldo atual</Text>
          <Text style={styles.balanceValue}>{formatQuantity(quantity)}</Text>
        </View>

        <Text style={styles.section}>Alerta de estoque baixo</Text>
        <Text style={styles.hint}>Avisa quando o saldo ficar igual ou abaixo deste valor (0 = sem alerta).</Text>
        <TextField
          label="Limite de alerta"
          value={threshold}
          onChangeText={setThreshold}
          placeholder="ex.: 10"
          keyboardType="decimal-pad"
        />
        <Button title="Salvar alerta" onPress={onSaveAlert} loading={saving} />

        <Text style={styles.section}>Histórico de entradas</Text>
        {currentCost && (
          <Text style={styles.hint}>Fornecedor atual: {currentSupplierName}</Text>
        )}
        {entries.length === 0 && <Text style={styles.hint}>Nenhuma entrada registrada.</Text>}
        {entries.map((e) => {
          const isMin = minQty != null && e.quantity === minQty;
          const isMax = maxQty != null && e.quantity === maxQty;
          const highlighted = minQty !== maxQty && (isMin || isMax);
          return (
            <View key={e.id} style={styles.entry}>
              <View style={styles.entryMain}>
                <Text style={styles.entryQty}>+{formatQuantity(e.quantity)}</Text>
                <Text style={styles.entryDate}>{formatDatePtBR(new Date(e.entryDate))}</Text>
              </View>
              <View style={styles.entryEnd}>
                {currentCost && (
                  <Text style={styles.entryCost}>{formatBRL(currentCost.purchasePrice)}</Text>
                )}
                {highlighted && (
                  <Text style={isMax ? styles.badgeMax : styles.badgeMin}>
                    {isMax ? 'maior' : 'menor'}
                  </Text>
                )}
              </View>
            </View>
          );
        })}

        <Button
          title="Ver histórico de preço de compra completo"
          variant="outline"
          onPress={() =>
            productId &&
            router.push({ pathname: '/estoque/historico-preco', params: { productId } })
          }
        />

        <Button title="Voltar" variant="text" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  balanceCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    marginVertical: spacing.md,
  },
  balanceLabel: { color: colors.textSecondary, fontSize: 14 },
  balanceValue: { color: colors.gold, fontSize: 36, fontWeight: '700', marginTop: spacing.xs },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.lg },
  hint: { color: colors.textSecondary, fontSize: 13 },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  entryMain: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  entryQty: { color: colors.green, fontSize: 16, fontWeight: '700' },
  entryDate: { color: colors.textSecondary, fontSize: 13 },
  entryEnd: { alignItems: 'flex-end', gap: 2 },
  entryCost: { color: colors.gold, fontSize: 15, fontWeight: '700' },
  badgeMax: { color: colors.green, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  badgeMin: { color: colors.danger, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
});
