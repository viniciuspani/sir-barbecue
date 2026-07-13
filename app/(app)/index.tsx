import { Ionicons } from '@expo/vector-icons';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { productRepository, saleRepository, stockRepository } from '@/data/repositories';
import { runSync } from '@/data/sync/syncEngine';
import type { Product } from '@/domain/entities/Product';
import type { PaymentMethod, Sale } from '@/domain/entities/Sale';
import type { StockItem } from '@/domain/entities/StockItem';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { hasSeenWelcome, markWelcomeSeen } from '@/services/onboarding';
import { DEFAULT_TENANT_NAME, fetchTenant } from '@/services/tenant';
import { useAuthStore } from '@/store/authStore';
import { BrandLogo } from '@/ui/BrandLogo';

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  pix: 'Pix',
  cash: 'Dinheiro',
  credit_card: 'Crédito',
  debit_card: 'Débito',
};
const PAYMENT_ORDER: PaymentMethod[] = ['pix', 'cash', 'credit_card', 'debit_card'];

// Rota recém-criada — cast até o typegen do expo-router (roda no `expo start`) reconhecê-la.
const WELCOME_ROUTE = '/boas-vindas' as Href;

function isLow(item: StockItem): boolean {
  return item.alertThreshold > 0 && item.quantity <= item.alertThreshold;
}

export default function Inicio() {
  const router = useRouter();
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const userId = useAuthStore((s) => s.user?.id);
  const [sales, setSales] = useState<Sale[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const welcomeChecked = useRef(false);

  useEffect(() => {
    const unsubSales = saleRepository.observeAll(setSales);
    const unsubStock = stockRepository.observeItems(setStock);
    const unsubProducts = productRepository.observeAll(setProducts);
    return () => {
      unsubSales();
      unsubStock();
      unsubProducts();
    };
  }, []);

  // Primeiro login: abre a tela de boas-vindas uma única vez (flag local por usuário).
  useEffect(() => {
    if (!currentTenantId || !userId || welcomeChecked.current) return;
    welcomeChecked.current = true;
    void (async () => {
      if (!(await hasSeenWelcome(userId))) {
        await markWelcomeSeen(userId);
        router.push(WELCOME_ROUTE);
      }
    })();
  }, [currentTenantId, userId, router]);

  // Nome da empresa (para o nudge) — recarrega ao focar a Home (reflete edições).
  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (currentTenantId) {
        fetchTenant(currentTenantId)
          .then((t) => {
            if (active) setTenantName(t?.name ?? null);
          })
          .catch(() => undefined);
      }
      return () => {
        active = false;
      };
    }, [currentTenantId]),
  );

  const now = new Date();
  const monthLabel = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(now);

  const stats = useMemo(() => {
    const ref = new Date();
    const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1).getTime();
    const monthSales = sales.filter((s) => s.saleDate >= monthStart);
    const total = monthSales.reduce((sum, s) => sum + s.totalAmount, 0);
    const byPayment = PAYMENT_ORDER.reduce<Record<PaymentMethod, number>>(
      (acc, method) => {
        acc[method] = monthSales
          .filter((s) => s.paymentMethod === method)
          .reduce((sum, s) => sum + s.totalAmount, 0);
        return acc;
      },
      { pix: 0, cash: 0, credit_card: 0, debit_card: 0 },
    );
    return { count: monthSales.length, total, byPayment };
  }, [sales]);

  const lowStock = stock.filter(isLow);
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? '—';

  const onRefresh = async () => {
    setRefreshing(true);
    await runSync(); // puxa catálogo + envia pendências (no-op offline / sem empresa)
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.gold} />
        }
      >
        <BrandLogo />
        <Text style={styles.title}>Início</Text>
        <Text style={styles.subtitle}>{monthLabel}</Text>

        {tenantName === DEFAULT_TENANT_NAME ? (
          <Pressable style={styles.nudge} onPress={() => router.push(WELCOME_ROUTE)}>
            <Ionicons name="storefront-outline" size={22} color={colors.gold} />
            <View style={styles.nudgeText}>
              <Text style={styles.nudgeTitle}>Dê um nome ao seu negócio</Text>
              <Text style={styles.nudgeBody}>Personalize o app com o nome do seu estabelecimento.</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        ) : null}

        <View style={styles.cardsRow}>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Faturamento do mês</Text>
            <Text style={styles.cardValue}>{formatBRL(stats.total)}</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Vendas do mês</Text>
            <Text style={styles.cardValue}>{stats.count}</Text>
          </View>
        </View>

        <Text style={styles.section}>Por forma de pagamento</Text>
        <View style={styles.block}>
          {PAYMENT_ORDER.map((method) => (
            <View key={method} style={styles.payRow}>
              <Text style={styles.payLabel}>{PAYMENT_LABELS[method]}</Text>
              <Text style={styles.payValue}>{formatBRL(stats.byPayment[method])}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.section}>Alertas de estoque</Text>
        <View style={styles.block}>
          {lowStock.length === 0 ? (
            <Text style={styles.okText}>Tudo certo — nenhum item abaixo do limite. ✅</Text>
          ) : (
            lowStock.map((item) => (
              <View key={item.id} style={styles.alertRow}>
                <Text style={styles.alertName}>{productName(item.productId)}</Text>
                <Text style={styles.alertQty}>{formatQuantity(item.quantity)} restante(s)</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700' },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    marginTop: 2,
    marginBottom: spacing.lg,
    textTransform: 'capitalize',
  },
  nudge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  nudgeText: { flex: 1 },
  nudgeTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  nudgeBody: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  cardsRow: { flexDirection: 'row', gap: spacing.sm },
  card: { flex: 1, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  cardLabel: { color: colors.textSecondary, fontSize: 13 },
  cardValue: { color: colors.gold, fontSize: 22, fontWeight: '700', marginTop: spacing.xs },
  section: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  block: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  payRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  payLabel: { color: colors.textSecondary, fontSize: 15 },
  payValue: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  okText: { color: colors.textSecondary, fontSize: 14 },
  alertRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  alertName: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  alertQty: { color: colors.yellow, fontSize: 14, fontWeight: '600' },
});
