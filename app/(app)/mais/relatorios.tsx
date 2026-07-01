import { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { productRepository, saleRepository } from '@/data/repositories';
import type { Product } from '@/domain/entities/Product';
import type { PaymentMethod, Sale } from '@/domain/entities/Sale';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { showToast } from '@/lib/toast';
import { generateReport, getReportSignedUrl } from '@/services/functions';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';

type Period = 'today' | 'week' | 'month';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: 'week', label: '7 dias' },
  { value: 'month', label: 'Mês' },
];
const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  credit_card: 'Crédito',
  debit_card: 'Débito',
};

function periodStart(period: Period): number {
  const d = new Date();
  if (period === 'today') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'week') {
    d.setDate(d.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export default function Relatorios() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [period, setPeriod] = useState<Period>('month');
  const [generating, setGenerating] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

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
    setGenerating(true);
    const start = new Date(periodStart(period));
    const reportType = period === 'today' ? 'daily_sales' : 'monthly_sales';
    const { path, error } = await generateReport({
      type: reportType,
      from: start.toISOString(),
      to: new Date().toISOString(),
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
    } catch {
      showToast('Falha ao carregar o relatório.');
    }
    setGenerating(false);
  };

  const report = useMemo(() => {
    const start = periodStart(period);
    const inPeriod = sales.filter((s) => s.saleDate >= start);
    const total = inPeriod.reduce((sum, s) => sum + s.totalAmount, 0);
    const byPayment = inPeriod.reduce<Record<string, number>>((acc, s) => {
      acc[s.paymentMethod] = (acc[s.paymentMethod] ?? 0) + s.totalAmount;
      return acc;
    }, {});
    const byProduct = new Map<string, number>();
    for (const sale of inPeriod) {
      for (const item of sale.items) {
        byProduct.set(item.productId, (byProduct.get(item.productId) ?? 0) + item.quantity);
      }
    }
    const topProducts = [...byProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { count: inPeriod.length, total, byPayment, topProducts };
  }, [sales, period]);

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

      <Button title="Gerar relatório (HTML)" onPress={onGenerate} loading={generating} />
      <Text style={styles.hint}>
        Gera relatório no servidor. Requer conexão.
      </Text>

      <Modal
        visible={reportHtml !== null}
        animationType="slide"
        onRequestClose={() => setReportHtml(null)}
      >
        <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Relatório</Text>
            <TouchableOpacity onPress={() => setReportHtml(null)} hitSlop={8}>
              <Text style={styles.modalClose}>Fechar</Text>
            </TouchableOpacity>
          </View>
          <WebView source={{ html: reportHtml ?? '' }} style={styles.webview} />
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  chips: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
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
  modalContainer: { flex: 1, backgroundColor: '#fff' },
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
  webview: { flex: 1 },
});
