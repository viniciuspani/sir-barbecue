import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  categoryRepository,
  productRepository,
  stockRepository,
  tabRepository,
} from '@/data/repositories';
import type { Category } from '@/domain/entities/Category';
import type { Product } from '@/domain/entities/Product';
import type { StockItem } from '@/domain/entities/StockItem';
import type { Tab } from '@/domain/entities/Tab';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity } from '@/lib/currency';
import { showToast } from '@/lib/toast';
import { useCartStore } from '@/store/cartStore';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { TextField } from '@/ui/TextField';

// RF-05: produto aparece na venda se ativo e visível no dia da semana atual.
function isVisibleToday(p: Product, weekday: number): boolean {
  return !p.visibleDays || p.visibleDays.length === 0 || p.visibleDays.includes(weekday);
}

export default function NovaVenda() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null); // null = todas

  // Destino dos produtos tocados: null = venda rápida (carrinho); id = comanda.
  const [targetTabId, setTargetTabId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [nameInput, setNameInput] = useState('');

  const cartItems = useCartStore((s) => s.items);
  const add = useCartStore((s) => s.add);
  const clear = useCartStore((s) => s.clear);
  const cartTotal = useCartStore((s) => s.total);
  const cartCount = useCartStore((s) => s.count);

  useEffect(() => {
    const unsubProducts = productRepository.observeAll(setProducts);
    const unsubCategories = categoryRepository.observeAll(setCategories);
    const unsubStock = stockRepository.observeItems(setStock);
    const unsubTabs = tabRepository.observeAll(setTabs);
    return () => {
      unsubProducts();
      unsubCategories();
      unsubStock();
      unsubTabs();
    };
  }, []);

  // Comanda selecionada deixou de existir (paga/excluída) → volta para a venda rápida.
  useEffect(() => {
    if (targetTabId && !tabs.some((t) => t.id === targetTabId)) setTargetTabId(null);
  }, [tabs, targetTabId]);

  const selectedTab = targetTabId ? tabs.find((t) => t.id === targetTabId) ?? null : null;

  const weekday = new Date().getDay();
  const visible = useMemo(
    () => products.filter((p) => p.isActive && isVisibleToday(p, weekday)),
    [products, weekday],
  );
  const filtered = categoryId ? visible.filter((p) => p.categoryId === categoryId) : visible;

  const stockQty = (id: string) => stock.find((s) => s.productId === id)?.quantity ?? 0;

  // Estoque comprometido = carrinho da venda rápida + soma de todas as comandas abertas.
  const committedQty = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of cartItems) map.set(i.productId, (map.get(i.productId) ?? 0) + i.quantity);
    for (const t of tabs) {
      for (const it of t.items) map.set(it.productId, (map.get(it.productId) ?? 0) + it.quantity);
    }
    return map;
  }, [cartItems, tabs]);

  const availableQty = (id: string) => stockQty(id) - (committedQty.get(id) ?? 0);

  // Quantidade do produto no destino atual (para o badge do card).
  const qtyInTarget = (id: string) => {
    if (selectedTab) return selectedTab.items.find((it) => it.productId === id)?.quantity ?? 0;
    return cartItems.find((i) => i.productId === id)?.quantity ?? 0;
  };

  // RF-10: não permite vender sem saldo (considera carrinho + todas as comandas abertas).
  const onAdd = (p: Product) => {
    if (availableQty(p.id) <= 0) {
      showToast('Estoque insuficiente. Registre uma entrada de estoque antes de vender.');
      return;
    }
    if (selectedTab) {
      tabRepository.addItem(selectedTab.id, { productId: p.id, name: p.name, unitPrice: p.price });
    } else {
      add({ productId: p.id, name: p.name, unitPrice: p.price });
    }
  };

  // Cancela a venda rápida em andamento limpando o carrinho.
  const onCancelQuick = () => {
    Alert.alert('Cancelar venda', 'Deseja cancelar a venda? Todos os itens serão removidos.', [
      { text: 'Voltar', style: 'cancel' },
      { text: 'Cancelar venda', style: 'destructive', onPress: () => clear() },
    ]);
  };

  // Exclui uma comanda aberta sem registrar venda (ex.: cliente desistiu).
  const onDeleteTab = (tab: Tab) => {
    Alert.alert(
      'Excluir comanda',
      `Excluir a comanda de ${tab.customerName}? Os itens não serão vendidos.`,
      [
        { text: 'Voltar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: () => tabRepository.close(tab.id) },
      ],
    );
  };

  const onCreateTab = async () => {
    const name = nameInput.trim();
    if (!name) {
      showToast('Informe o nome do cliente.');
      return;
    }
    const tab = await tabRepository.open(name);
    setTargetTabId(tab.id);
    setNameInput('');
    setModalOpen(false);
  };

  const tabTotal = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const tabCount = (tab: Tab) => tab.items.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Text style={styles.title}>Nova Venda</Text>

      {/* Seletor de destino: venda rápida | comandas abertas | nova comanda */}
      <View style={styles.targetsWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.targets}
        >
          <Chip
            label={cartCount() > 0 ? `Venda rápida (${cartCount()})` : 'Venda rápida'}
            selected={targetTabId === null}
            onPress={() => setTargetTabId(null)}
          />
          {tabs.map((t) => (
            <Chip
              key={t.id}
              label={`${t.customerName} (${tabCount(t)})`}
              selected={targetTabId === t.id}
              onPress={() => setTargetTabId(t.id)}
            />
          ))}
          <Pressable
            style={styles.newTab}
            onPress={() => setModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir nova comanda"
          >
            <Text style={styles.newTabText}>+ Comanda</Text>
          </Pressable>
        </ScrollView>
      </View>

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
          const inTarget = qtyInTarget(item.id);
          const sQty = stockQty(item.id);
          const out = availableQty(item.id) <= 0;
          return (
            <Pressable
              style={[styles.card, out && styles.cardOut]}
              onPress={() => onAdd(item)}
              accessibilityRole="button"
              accessibilityLabel={`Adicionar ${item.name}`}
            >
              {inTarget > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{inTarget}</Text>
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

      {/* Barra de ação — venda rápida */}
      {selectedTab === null && cartCount() > 0 && (
        <View style={styles.actionsBar}>
          <Pressable
            style={styles.cancelButton}
            onPress={onCancelQuick}
            accessibilityRole="button"
            accessibilityLabel="Cancelar venda"
          >
            <Text style={styles.cancelButtonText}>Cancelar</Text>
          </Pressable>
          <Pressable
            style={styles.closeButton}
            onPress={() => router.push('/venda/fechar')}
            accessibilityRole="button"
            accessibilityLabel="Fechar venda"
          >
            <Text style={styles.closeButtonText}>{cartCount()} item(ns)</Text>
            <Text style={styles.closeButtonCta}>Fechar · {formatBRL(cartTotal())}</Text>
          </Pressable>
        </View>
      )}

      {/* Barra de ação — comanda selecionada */}
      {selectedTab !== null && (
        <View style={styles.actionsBar}>
          <Pressable
            style={styles.cancelButton}
            onPress={() => onDeleteTab(selectedTab)}
            accessibilityRole="button"
            accessibilityLabel={`Excluir comanda de ${selectedTab.customerName}`}
          >
            <Text style={styles.cancelButtonText}>Excluir</Text>
          </Pressable>
          <Pressable
            style={[styles.closeButton, tabCount(selectedTab) === 0 && styles.closeButtonDisabled]}
            disabled={tabCount(selectedTab) === 0}
            onPress={() =>
              router.push({
                pathname: '/venda/fechar',
                params: { tabId: selectedTab.id, customerName: selectedTab.customerName },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`Fechar comanda de ${selectedTab.customerName}`}
          >
            <Text style={styles.closeButtonText}>
              {selectedTab.customerName} · {tabCount(selectedTab)} item(ns)
            </Text>
            <Text style={styles.closeButtonCta}>Fechar · {formatBRL(tabTotal(selectedTab))}</Text>
          </Pressable>
        </View>
      )}

      {/* Modal — abrir comanda pelo nome do cliente */}
      <Modal
        visible={modalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Nova comanda</Text>
            <TextField
              label="Nome do cliente"
              placeholder="Ex.: João da mesa 3"
              value={nameInput}
              onChangeText={setNameInput}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={onCreateTab}
            />
            <Button title="Abrir comanda" onPress={onCreateTab} />
            <Button
              title="Cancelar"
              variant="text"
              onPress={() => {
                setNameInput('');
                setModalOpen(false);
              }}
            />
          </View>
        </View>
      </Modal>
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
  targetsWrap: { paddingTop: spacing.sm },
  targets: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  newTab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.gold,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  newTabText: { color: colors.gold, fontSize: 14, fontWeight: '700' },
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
  actionsBar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  cancelButton: {
    backgroundColor: colors.red,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  closeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.green,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  closeButtonDisabled: { opacity: 0.5 },
  closeButtonText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  closeButtonCta: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
});
