import { Redirect } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { productRepository, saleRepository } from '@/data/repositories';
import { usePermissions } from '@/lib/permissions';
import type { Product } from '@/domain/entities/Product';
import type { PaymentMethod, Sale } from '@/domain/entities/Sale';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { reportError } from '@/lib/feedback';
import { showToast } from '@/lib/toast';
import { generateReport, getReportSignedUrl } from '@/services/functions';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { DateField } from '@/ui/DateField';
import { FullscreenModal } from '@/ui/FullscreenModal';
import { ReportViewer } from '@/ui/ReportViewer';

type Period = 'today' | 'week' | 'month' | 'custom';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: 'Esta semana' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
];
const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  credit_card: 'Crédito',
  debit_card: 'Débito',
};

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Início/fim (em ms) do período selecionado. `custom` usa as datas escolhidas pela pessoa. */
function periodRange(period: Period, customFrom: Date, customTo: Date): { start: number; end: number } {
  const now = new Date();
  if (period === 'today') return { start: startOfDay(now).getTime(), end: now.getTime() };
  if (period === 'week') {
    // Semana começando na segunda-feira (padrão comercial no Brasil).
    const weekday = now.getDay(); // 0=domingo..6=sábado
    const diffToMonday = weekday === 0 ? 6 : weekday - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    return { start: startOfDay(monday).getTime(), end: now.getTime() };
  }
  if (period === 'month') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end: now.getTime() };
  }
  return { start: startOfDay(customFrom).getTime(), end: endOfDay(customTo).getTime() };
}

export default function Relatorios() {
  const { canAccessReports } = usePermissions();
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [period, setPeriod] = useState<Period>('month');
  const [customFrom, setCustomFrom] = useState<Date>(() => startOfDay(new Date()));
  const [customTo, setCustomTo] = useState<Date>(() => startOfDay(new Date()));
  const [generating, setGenerating] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const customRangeInvalid = period === 'custom' && customFrom.getTime() > customTo.getTime();

  useEffect(() => {
    const unsubSales = saleRepository.observeAll(setSales);
    const unsubProducts = productRepository.observeAll(setProducts);
    return () => {
      unsubSales();
      unsubProducts();
    };
  }, []);

  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? '—';

  const onGenerate = async () => {
    if (customRangeInvalid) {
      showToast('A data inicial deve ser anterior à final.');
      return;
    }
    setGenerating(true);
    const { start, end } = periodRange(period, customFrom, customTo);
    const reportType = period === 'today' ? 'daily_sales' : period === 'month' ? 'monthly_sales' : 'period_sales';
    const { path, error } = await generateReport({
      type: reportType,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
    });
    if (error || !path) {
      setGenerating(false);
      showToast(error ?? 'Falha ao gerar o relatório.');
      return;
    }
    const url = await getReportSignedUrl(path);
    if (!url) {
      setGenerating(false);
      showToast('Falha ao abrir o relatório.');
      return;
    }
    try {
      const res = await fetch(url);
      const html = await res.text();
      setReportHtml(html);
    } catch (e) {
      await reportError(e, {
        action: 'Carregar o relatório gerado',
        title: 'Não foi possível abrir o relatório',
        meta: { reportType, period },
      });
    }
    setGenerating(false);
  };

  const report = useMemo(() => {
    const { start, end } = periodRange(period, customFrom, customTo);
    const inPeriod = sales.filter((s) => s.saleDate >= start && s.saleDate <= end);
    const total = inPeriod.reduce((sum, s) => sum + s.totalAmount, 0);
    // Fonte da verdade é `payments` (soma cada forma de verdade, mesmo dentro
    // de uma venda dividida). Venda de ANTES da MIGRATION_28 nunca teve linha
    // em sale_payments — cai de volta no paymentMethod/total de sempre.
    const byPayment: Record<string, number> = {};
    for (const s of inPeriod) {
      if (s.payments.length > 0) {
        for (const p of s.payments) byPayment[p.method] = (byPayment[p.method] ?? 0) + p.amount;
      } else {
        byPayment[s.paymentMethod] = (byPayment[s.paymentMethod] ?? 0) + s.totalAmount;
      }
    }
    const byProduct = new Map<string, number>();
    for (const sale of inPeriod) {
      for (const item of sale.items) {
        byProduct.set(item.productId, (byProduct.get(item.productId) ?? 0) + item.quantity);
      }
    }
    const topProducts = [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { count: inPeriod.length, total, byPayment, topProducts };
  }, [sales, period, customFrom, customTo]);

  // employee não acessa Relatórios (guarda de deep-link; a RLS confirma no servidor).
  if (!canAccessReports) return <Redirect href="/mais" />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.chips}>
        {PERIODS.map((p) => (
          <Chip
            key={p.value}
            label={p.label}
            selected={period === p.value}
            onPress={() => setPeriod(p.value)}
          />
        ))}
      </View>

      {period === 'custom' && (
        <View style={styles.customRange}>
          <DateField label="De" value={customFrom} maximumDate={customTo} onChange={setCustomFrom} />
          <DateField label="Até" value={customTo} minimumDate={customFrom} maximumDate={new Date()} onChange={setCustomTo} />
        </View>
      )}
      {customRangeInvalid && (
        <Text style={styles.warning}>A data inicial deve ser anterior à final.</Text>
      )}

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Faturamento</Text>
        <Text style={styles.cardValue}>{formatBRL(report.total)}</Text>
        <Text style={styles.cardSub}>{report.count} venda(s)</Text>
      </View>

      <Text style={styles.section}>Produtos mais vendidos</Text>
      <View style={styles.block}>
        {report.topProducts.length === 0 ? (
          <Text style={styles.hint}>Sem vendas no período.</Text>
        ) : (
          report.topProducts.map(([pid, qty]) => (
            <View key={pid} style={styles.row}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {productName(pid)}
              </Text>
              <Text style={styles.rowValue}>{formatQuantity(qty)}</Text>
            </View>
          ))
        )}
      </View>

      <Text style={styles.section}>Por forma de pagamento</Text>
      <View style={styles.block}>
        {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((m) => (
          <View key={m} style={styles.row}>
            <Text style={styles.rowLabel}>{PAYMENT_LABELS[m]}</Text>
            <Text style={styles.rowValue}>{formatBRL(report.byPayment[m] ?? 0)}</Text>
          </View>
        ))}
      </View>

      <Button
        title="Gerar relatório (HTML)"
        onPress={onGenerate}
        loading={generating}
        disabled={customRangeInvalid}
      />
      <Text style={styles.hint}>
        Gera relatório no servidor. Requer conexão.
      </Text>

      <FullscreenModal visible={reportHtml !== null} onRequestClose={() => setReportHtml(null)}>
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Relatório</Text>
            <TouchableOpacity onPress={() => setReportHtml(null)} hitSlop={8}>
              <Text style={styles.modalClose}>Fechar</Text>
            </TouchableOpacity>
          </View>
          <ReportViewer html={reportHtml ?? ''} />
        </View>
      </FullscreenModal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  customRange: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  warning: { color: colors.danger, fontSize: 13, marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg, alignItems: 'center' },
  cardLabel: { color: colors.textSecondary, fontSize: 13 },
  cardValue: { color: colors.gold, fontSize: 30, fontWeight: '700', marginTop: spacing.xs },
  cardSub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.lg },
  block: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
  rowLabel: { flex: 1, color: colors.textSecondary, fontSize: 15 },
  rowValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.md },
  modalContainer: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.surface,
  },
  modalTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  modalClose: { color: colors.gold, fontSize: 15 },
});
