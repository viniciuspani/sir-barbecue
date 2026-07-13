import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { saleRepository, stockRepository, tabRepository } from '@/data/repositories';
import { refreshPendingCount, runSync } from '@/data/sync/syncEngine';
import type { ConsumptionMode, PaymentMethod } from '@/domain/entities/Sale';
import type { StockItem } from '@/domain/entities/StockItem';
import type { Tab } from '@/domain/entities/Tab';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL } from '@/lib/currency';
import { showToast } from '@/lib/toast';
import { useCartStore, type CartItem } from '@/store/cartStore';
import { BrandLogo } from '@/ui/BrandLogo';
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
  // tabId presente → fechamento de comanda; ausente → venda rápida (carrinho).
  const params = useLocalSearchParams<{ tabId?: string; customerName?: string }>();
  const tabId = params.tabId;
  const clearCart = useCartStore((s) => s.clear);
  const cartItems = useCartStore((s) => s.items);

  // Lista editável desta finalização, semeada do carrinho ou da comanda.
  // Editar aqui é a revisão final: não altera o carrinho/comanda até confirmar.
  const [lines, setLines] = useState<CartItem[]>(() =>
    tabId ? [] : useCartStore.getState().items.map((i) => ({ ...i })),
  );

  const [payment, setPayment] = useState<PaymentMethod>('pix');
  const [consumption, setConsumption] = useState<ConsumptionMode>('on_site');
  const [saving, setSaving] = useState(false);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);

  useEffect(() => stockRepository.observeItems(setStock), []);
  useEffect(() => tabRepository.observeAll(setTabs), []);

  useEffect(() => {
    if (!tabId) return;
    tabRepository
      .get(tabId)
      .then((t) => {
        if (t) {
          setLines(
            t.items.map((i) => ({
              productId: i.productId,
              name: i.name,
              unitPrice: i.unitPrice,
              quantity: i.quantity,
            })),
          );
        }
      })
      .catch(() => undefined);
  }, [tabId]);

  const stockQty = (id: string) => stock.find((s) => s.productId === id)?.quantity ?? 0;
  const total = lines.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

  // Opção B: o saldo disponível para ESTA finalização é o estoque menos o que já está
  // comprometido em OUTRAS fontes abertas (carrinho + demais comandas). Assim nunca
  // confirmamos uma venda que o servidor recusaria pelo CHECK quantity >= 0.
  const committedElsewhere = (productId: string) => {
    let n = 0;
    if (tabId) {
      // Fechando uma comanda → concorrem o carrinho e as demais comandas.
      for (const i of cartItems) if (i.productId === productId) n += i.quantity;
      for (const t of tabs) {
        if (t.id === tabId) continue;
        for (const it of t.items) if (it.productId === productId) n += it.quantity;
      }
    } else {
      // Fechando a venda rápida (carrinho é a própria `lines`) → concorrem as comandas.
      for (const t of tabs) {
        for (const it of t.items) if (it.productId === productId) n += it.quantity;
      }
    }
    return n;
  };
  const availableFor = (productId: string) => stockQty(productId) - committedElsewhere(productId);

  const increment = (id: string) => {
    if ((lines.find((l) => l.productId === id)?.quantity ?? 0) >= availableFor(id)) {
      showToast('Estoque insuficiente. Registre uma entrada de estoque antes de vender.');
      return;
    }
    setLines((prev) =>
      prev.map((l) => (l.productId === id ? { ...l, quantity: l.quantity + 1 } : l)),
    );
  };

  const decrement = (id: string) => {
    setLines((prev) =>
      prev.flatMap((l) => {
        if (l.productId !== id) return [l];
        if (l.quantity <= 1) return [];
        return [{ ...l, quantity: l.quantity - 1 }];
      }),
    );
  };

  const onConfirm = async () => {
    if (lines.length === 0) return;
    // RF-10 / Opção B: trava final — não confirma venda acima do saldo disponível
    // (estoque menos reservas de outras comandas/carrinho). Evita o CHECK do servidor.
    const insufficient = lines.find((i) => i.quantity > availableFor(i.productId));
    if (insufficient) {
      showToast(
        `Estoque insuficiente de ${insufficient.name}. Registre uma entrada de estoque antes de vender.`,
      );
      return;
    }
    setSaving(true);
    await saleRepository.create({
      paymentMethod: payment,
      consumptionMode: consumption,
      items: lines.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
    });
    // RF-10: baixa de estoque LOCAL (só produtos com saldo controlado).
    // No servidor, o trigger deduct_stock_on_sale refaz a baixa quando a venda sincroniza.
    await stockRepository.deductForSale(
      lines.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );
    // Encerra a fonte: fecha a comanda paga OU limpa o carrinho da venda rápida.
    if (tabId) {
      await tabRepository.close(tabId);
    } else {
      clearCart();
    }
    setSaving(false);
    showToast('Venda registrada! ✅');
    refreshPendingCount();
    runSync(); // tenta enviar agora (no-op offline / sem empresa ativa)
    router.back();
  };

  if (lines.length === 0) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.emptyWrap}>
          <Text style={styles.empty}>{tabId ? 'Comanda sem itens.' : 'Carrinho vazio.'}</Text>
          <Button title="Voltar" variant="outline" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandLogo />
        <Text style={styles.title}>
          {params.customerName ? `Fechar comanda · ${params.customerName}` : 'Fechar venda'}
        </Text>

        {lines.map((i) => (
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
                onPress={() => increment(i.productId)}
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
          <Text style={styles.totalValue}>{formatBRL(total)}</Text>
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
