import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { saleRepository, stockRepository } from '@/data/repositories';
import { refreshPendingCount, runSync } from '@/data/sync/syncEngine';
import type { ConsumptionMode, PaymentMethod } from '@/domain/entities/Sale';
import type { StockItem } from '@/domain/entities/StockItem';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL } from '@/lib/currency';
import { showToast } from '@/lib/toast';
import { useCartStore } from '@/store/cartStore';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';

const PAYMENTS: { value: PaymentMethod; label: string }[] = [
  { value: 'pix', label: 'Pix' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'credit_card', label: 'Crédito' },
  { value: 'debit_card', label: 'Débito' },
];

const CONSUMPTION: { value: ConsumptionMode; label: string }[] = [
  { value: 'on_site', label: 'No local' },
  { value: 'takeaway', label: 'Para viagem' },
];

export default function FecharVenda() {
  const items = useCartStore((s) => s.items);
  const add = useCartStore((s) => s.add);
  const decrement = useCartStore((s) => s.decrement);
  const clear = useCartStore((s) => s.clear);
  const total = useCartStore((s) => s.total);

  const [payment, setPayment] = useState<PaymentMethod>('pix');
  const [consumption, setConsumption] = useState<ConsumptionMode>('on_site');
  const [saving, setSaving] = useState(false);
  const [stock, setStock] = useState<StockItem[]>([]);

  useEffect(() => stockRepository.observeItems(setStock), []);
  const stockQty = (id: string) => stock.find((s) => s.productId === id)?.quantity ?? 0;

  const onConfirm = async () => {
    if (items.length === 0) return;
    // RF-10: trava final — não confirma venda acima do saldo disponível.
    const insufficient = items.find((i) => i.quantity > stockQty(i.productId));
    if (insufficient) {
      showToast(`Sem estoque suficiente: ${insufficient.name}`);
      return;
    }
    setSaving(true);
    await saleRepository.create({
      paymentMethod: payment,
      consumptionMode: consumption,
      items: items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
    });
    // RF-10: baixa de estoque LOCAL (só produtos com saldo controlado).
    // No servidor, o trigger deduct_stock_on_sale refaz a baixa quando a venda sincroniza.
    await stockRepository.deductForSale(
      items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );
    clear();
    setSaving(false);
    showToast('Venda registrada! ✅');
    refreshPendingCount();
    runSync(); // tenta enviar agora (no-op offline / sem empresa ativa)
    router.back();
  };

  if (items.length === 0) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.emptyWrap}>
          <Text style={styles.empty}>Carrinho vazio.</Text>
          <Button title="Voltar" variant="outline" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Fechar venda</Text>

        {items.map((i) => (
          <View key={i.productId} style={styles.item}>
            <View style={styles.itemMain}>
              <Text style={styles.itemName}>{i.name}</Text>
              <Text style={styles.itemUnit}>{formatBRL(i.unitPrice)} · un</Text>
            </View>
            <View style={styles.qtyRow}>
              <Pressable
                style={styles.qtyBtn}
                onPress={() => decrement(i.productId)}
                accessibilityLabel={`Diminuir ${i.name}`}
              >
                <Text style={styles.qtyBtnText}>−</Text>
              </Pressable>
              <Text style={styles.qty}>{i.quantity}</Text>
              <Pressable
                style={styles.qtyBtn}
                onPress={() => {
                  if (i.quantity >= stockQty(i.productId)) {
                    showToast('Sem estoque disponível.');
                    return;
                  }
                  add({ productId: i.productId, name: i.name, unitPrice: i.unitPrice });
                }}
                accessibilityLabel={`Aumentar ${i.name}`}
              >
                <Text style={styles.qtyBtnText}>+</Text>
              </Pressable>
            </View>
            <Text style={styles.lineTotal}>{formatBRL(i.unitPrice * i.quantity)}</Text>
          </View>
        ))}

        <Text style={styles.section}>Pagamento</Text>
        <View style={styles.chips}>
          {PAYMENTS.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              selected={payment === p.value}
              onPress={() => setPayment(p.value)}
            />
          ))}
        </View>

        <Text style={styles.section}>Consumo</Text>
        <View style={styles.chips}>
          {CONSUMPTION.map((c) => (
            <Chip
              key={c.value}
              label={c.label}
              selected={consumption === c.value}
              onPress={() => setConsumption(c.value)}
            />
          ))}
        </View>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatBRL(total())}</Text>
        </View>

        <Button title="Confirmar venda" onPress={onConfirm} loading={saving} />
        <Button title="Cancelar" variant="text" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700', marginBottom: spacing.md },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  empty: { color: colors.textSecondary, fontSize: 16 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  itemMain: { flex: 1 },
  itemName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  itemUnit: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.md },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { color: colors.gold, fontSize: 20, fontWeight: '700' },
  qty: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', minWidth: 20, textAlign: 'center' },
  lineTotal: { color: colors.gold, fontSize: 15, fontWeight: '700', minWidth: 70, textAlign: 'right' },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  totalLabel: { color: colors.textSecondary, fontSize: 18, fontWeight: '600' },
  totalValue: { color: colors.gold, fontSize: 24, fontWeight: '700' },
});
