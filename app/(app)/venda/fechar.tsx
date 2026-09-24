import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { saleRepository, stockRepository, tabRepository } from '@/data/repositories';
import { refreshPendingCount, runSync } from '@/data/sync/syncEngine';
import type { ConsumptionMode, PaymentMethod, SalePayment } from '@/domain/entities/Sale';
import type { StockItem } from '@/domain/entities/StockItem';
import type { Tab } from '@/domain/entities/Tab';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, parseBRL } from '@/lib/currency';
import { logSilently, reportError } from '@/lib/feedback';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { useCartStore, type CartItem } from '@/store/cartStore';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { MoneyField } from '@/ui/MoneyField';

const PAYMENTS: { value: PaymentMethod; label: string }[] = [
  { value: 'pix', label: 'Pix' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'credit_card', label: 'Crédito' },
  { value: 'debit_card', label: 'Débito' },
];

/** Máximo de formas de pagamento numa venda: uma por método existente. */
const MAX_SALE_PAYMENTS = PAYMENTS.length;

const CONSUMPTION: { value: ConsumptionMode; label: string }[] = [
  { value: 'on_site', label: 'No local' },
  { value: 'takeaway', label: 'Para viagem' },
];

/** Linha extra de pagamento: a 1ª forma sempre absorve o que sobrar (ver `firstAmount`). */
type ExtraPayment = { rowId: string; method: PaymentMethod; amountText: string };

type PaymentSplitError = 'duplicate' | 'over-allocated' | 'zero-amount' | 'empty';

/** Mesma regra usada no servidor (create_sale) e no web (core/rules/sale.ts). */
function paymentSplitError(
  payments: SalePayment[],
  extraPayments: SalePayment[],
  remainder: number,
): PaymentSplitError | null {
  if (new Set(payments.map((p) => p.method)).size !== payments.length) return 'duplicate';
  if (remainder < 0) return 'over-allocated';
  if (extraPayments.some((p) => p.amount <= 0)) return 'zero-amount';
  if (payments.length === 0) return 'empty';
  return null;
}

const PAYMENT_SPLIT_ERROR_MESSAGES: Record<PaymentSplitError, (remainder: number) => string> = {
  duplicate: () => 'Não repita a mesma forma de pagamento em duas linhas.',
  'over-allocated': (remainder) =>
    `A soma das formas de pagamento passou do total em ${formatBRL(-remainder)}.`,
  'zero-amount': () => 'Informe um valor maior que zero em cada forma de pagamento.',
  empty: () => 'Informe ao menos uma forma de pagamento.',
};

export default function FecharVenda() {
  // tabId presente → fechamento de comanda; ausente → venda rápida (carrinho).
  const params = useLocalSearchParams<{ tabId?: string; customerName?: string }>();
  const tabId = params.tabId;
  const clearCart = useCartStore((s) => s.clear);
  const cartItems = useCartStore((s) => s.items);
  const { readOnlyReason } = usePermissions();

  // Lista editável desta finalização, semeada do carrinho ou da comanda.
  // Editar aqui é a revisão final: não altera o carrinho/comanda até confirmar.
  const [lines, setLines] = useState<CartItem[]>(() =>
    tabId ? [] : useCartStore.getState().items.map((i) => ({ ...i })),
  );

  // Quantidade original de cada produto NA COMANDA, capturada uma vez junto do
  // seed de `lines`. Sem isto o stepper deixaria "pagar" mais do que a comanda
  // realmente tem — o que sobrar dela deve continuar lá, não ser inventado.
  const [originalTabQty, setOriginalTabQty] = useState<Map<string, number>>(new Map());
  const [firstMethod, setFirstMethod] = useState<PaymentMethod>('pix');
  const [extraPayments, setExtraPayments] = useState<ExtraPayment[]>([]);
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
          setOriginalTabQty(new Map(t.items.map((i) => [i.productId, i.quantity])));
        }
      })
      .catch((e) => logSilently(e, { action: 'Carregar a comanda', meta: { tabId } }));
  }, [tabId]);

  const stockQty = (id: string) => stock.find((s) => s.productId === id)?.quantity ?? 0;
  const total = lines.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

  // O que ainda falta alocar entre as formas extras entra na 1ª forma — ela
  // nunca é digitada, é sempre o que sobra. Garante a soma = total por
  // construção, em vez de exigir o operador acertar a conta na mão.
  const extraAsPayments: SalePayment[] = extraPayments.map((p) => ({
    method: p.method,
    amount: parseBRL(p.amountText),
  }));
  const firstAmount = total - extraAsPayments.reduce((sum, p) => sum + p.amount, 0);
  const payments: SalePayment[] = [{ method: firstMethod, amount: firstAmount }, ...extraAsPayments]
    .filter((p) => p.amount > 0); // forma sem valor não é enviada (CHECK amount > 0 no servidor)
  const usedMethods = new Set([firstMethod, ...extraPayments.map((p) => p.method)]);
  // Sobrou item de fora de `lines` (removido pelo "−") ou alguma linha ficou
  // abaixo do que a comanda tinha: o que não está sendo pago agora continua
  // aberto — os botões e o aviso na tela precisam deixar isso claro.
  const isPartialTabPayment =
    !!tabId &&
    (lines.length < originalTabQty.size ||
      lines.some((l) => l.quantity < (originalTabQty.get(l.productId) ?? 0)));

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
    const current = lines.find((l) => l.productId === id)?.quantity ?? 0;
    // Numa comanda, o teto não é só o estoque — é também o que ela realmente
    // tem daquele produto. Sem isto dava pra "pagar" mais do que existe na mesa.
    const tabCeiling = tabId ? (originalTabQty.get(id) ?? 0) : Infinity;
    if (current >= Math.min(availableFor(id), tabCeiling)) {
      showToast(
        tabId && current >= tabCeiling
          ? 'A comanda não tem mais desse item.'
          : 'Estoque insuficiente. Registre uma entrada de estoque antes de vender.',
      );
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

  const addPaymentRow = () => {
    const unused = PAYMENTS.find((o) => !usedMethods.has(o.value));
    if (!unused) return; // já usou as 4 formas — não cabe mais nenhuma
    setExtraPayments((prev) => [
      ...prev,
      { rowId: Crypto.randomUUID(), method: unused.value, amountText: '' },
    ]);
  };

  const removePaymentRow = (rowId: string) => {
    setExtraPayments((prev) => prev.filter((x) => x.rowId !== rowId));
  };

  const updatePaymentRow = (
    rowId: string,
    patch: Partial<Pick<ExtraPayment, 'method' | 'amountText'>>,
  ) => {
    setExtraPayments((prev) => prev.map((x) => (x.rowId === rowId ? { ...x, ...patch } : x)));
  };

  /**
   * @param queue Pedido PRÉ-PAGO: em vez de encerrar, a comanda vai para a fila
   *   da churrasqueira. É o fluxo do pico de movimento — a atendente cobra antes
   *   de o pedido ser produzido para não perder o pagamento, e quem está na
   *   grelha precisa continuar vendo o que assar e de quem é.
   */
  const onConfirm = async (queue: boolean) => {
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
    const paymentError = paymentSplitError(
      [{ method: firstMethod, amount: firstAmount }, ...extraAsPayments],
      extraAsPayments,
      firstAmount,
    );
    if (paymentError) {
      showToast(PAYMENT_SPLIT_ERROR_MESSAGES[paymentError](firstAmount));
      return;
    }
    setSaving(true);
    try {
      await saleRepository.create({
        payments,
        consumptionMode: consumption,
        tabId: tabId ?? undefined,
        customerName: params.customerName,
        queue,
        items: lines.map((i) => ({
          productId: i.productId,
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      });
      // RF-10: baixa de estoque LOCAL (só produtos com saldo controlado).
      // No servidor, o trigger deduct_stock_on_sale refaz a baixa quando a venda sincroniza.
      await stockRepository.deductForSale(
        lines.map((i) => ({ productId: i.productId, quantity: i.quantity })),
      );
      // payPartial sempre baixa o que foi pago. A comanda só fecha quando NÃO
      // há fila (pré-pago nunca fecha, é assim que o mesmo cliente pede de
      // novo) E o pagamento esgotou o que ela tinha.
      if (tabId) {
        const exhausted = await tabRepository.payPartial(
          tabId,
          lines.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        );
        if (!queue && exhausted) await tabRepository.close(tabId);
      } else {
        clearCart();
      }
      showToast(queue ? 'Pago! Pedido na churrasqueira 🔥' : 'Venda registrada! ✅');
      refreshPendingCount();
      runSync(); // tenta enviar agora (no-op offline / sem empresa ativa)
      router.back();
    } catch (e) {
      // Venda é o momento crítico do PDV: o operador precisa saber que NÃO
      // registrou, com o código em mãos, em vez de achar que deu certo.
      await reportError(e, {
        action: tabId ? 'Fechar comanda' : 'Confirmar venda',
        title: 'Não foi possível registrar a venda',
        meta: { tabId: tabId ?? null, itemCount: lines.length, total },
      });
    } finally {
      setSaving(false);
    }
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
              <Text style={styles.itemUnit}>
                {formatBRL(i.unitPrice)} · un
                {tabId && i.quantity < (originalTabQty.get(i.productId) ?? 0)
                  ? ` · pagando ${i.quantity} de ${originalTabQty.get(i.productId)} — resto fica na comanda`
                  : ''}
              </Text>
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
          {PAYMENTS.filter((p) => p.value === firstMethod || !usedMethods.has(p.value)).map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              selected={firstMethod === p.value}
              onPress={() => setFirstMethod(p.value)}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          {extraPayments.length === 0
            ? formatBRL(total)
            : `${formatBRL(Math.max(0, firstAmount))} (o que sobrar das outras formas)`}
        </Text>

        {extraPayments.map((p) => (
          <View key={p.rowId} style={styles.extraPaymentRow}>
            <View style={styles.extraPaymentFields}>
              <View style={styles.chips}>
                {PAYMENTS.filter((o) => o.value === p.method || !usedMethods.has(o.value)).map(
                  (o) => (
                    <Chip
                      key={o.value}
                      label={o.label}
                      selected={p.method === o.value}
                      onPress={() => updatePaymentRow(p.rowId, { method: o.value })}
                    />
                  ),
                )}
              </View>
              <MoneyField
                label={`Valor no ${PAYMENTS.find((o) => o.value === p.method)?.label}`}
                value={p.amountText}
                onChangeText={(v) => updatePaymentRow(p.rowId, { amountText: v })}
              />
            </View>
            <Pressable
              style={styles.qtyBtn}
              onPress={() => removePaymentRow(p.rowId)}
              accessibilityLabel="Remover esta forma de pagamento"
            >
              <Text style={styles.qtyBtnText}>×</Text>
            </Pressable>
          </View>
        ))}

        {1 + extraPayments.length < MAX_SALE_PAYMENTS && (
          <Pressable onPress={addPaymentRow} accessibilityRole="button">
            <Text style={styles.addPayment}>+ Adicionar forma de pagamento</Text>
          </Pressable>
        )}

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

        {isPartialTabPayment && (
          <Text style={styles.hint}>
            Isto paga só o que está marcado acima. O restante continua na comanda, em aberto.
          </Text>
        )}

        {/* Numa comanda o pagamento tem dois desfechos. O pré-pago ("mandar p/
            churrasqueira") NUNCA fecha a comanda — total ou parcial do que ela
            tem agora, ela continua aberta pra o mesmo cliente pedir de novo (o
            ticket de cozinha é da VENDA, não da comanda). Só "Receber e
            encerrar" fecha, e só quando o pagamento é total. */}
        {tabId ? (
          <>
            <Button
              title="Receber e mandar p/ churrasqueira"
              onPress={() => onConfirm(true)}
              loading={saving}
              disabledReason={readOnlyReason ?? undefined}
            />
            <Button
              title={isPartialTabPayment ? 'Receber pagamento parcial' : 'Receber e encerrar'}
              variant="outline"
              onPress={() => onConfirm(false)}
              disabled={saving}
              disabledReason={readOnlyReason ?? undefined}
            />
          </>
        ) : (
          <Button
            title="Confirmar venda"
            onPress={() => onConfirm(false)}
            loading={saving}
            disabledReason={readOnlyReason ?? undefined}
          />
        )}
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
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.xs },
  extraPaymentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  extraPaymentFields: { flex: 1, gap: spacing.xs },
  addPayment: { color: colors.gold, fontSize: 13, fontWeight: '600', marginTop: spacing.xs },
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
