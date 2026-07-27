import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { productRepository, supplierRepository } from '@/data/repositories';
import { runSync } from '@/data/sync/syncEngine';
import type { Product } from '@/domain/entities/Product';
import type { ProductSupplier } from '@/domain/entities/ProductSupplier';
import type { Supplier } from '@/domain/entities/Supplier';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatMoneyInput, parseBRL } from '@/lib/currency';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { MoneyField } from '@/ui/MoneyField';

export default function FornecedorDetalhe() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { canAccessSuppliers, canWriteSuppliers } = usePermissions();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [links, setLinks] = useState<ProductSupplier[]>([]);
  const [pickProductId, setPickProductId] = useState<string | undefined>();
  const [price, setPrice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');

  const reloadLinks = () => {
    if (id) supplierRepository.listLinks(id).then(setLinks).catch(() => undefined);
  };

  useEffect(() => {
    if (!id) return;
    supplierRepository.getById(id).then(setSupplier).catch(() => undefined);
    supplierRepository.listLinks(id).then(setLinks).catch(() => undefined);
    const unsub = productRepository.observeAll(setProducts);
    return unsub;
  }, [id]);

  const productName = (pid: string) => products.find((p) => p.id === pid)?.name ?? '—';
  const linkable = products.filter((p) => !links.some((l) => l.productId === p.id));

  const onAddLink = async () => {
    if (!id || !pickProductId) {
      showToast('Selecione um produto.');
      return;
    }
    const pp = parseBRL(price);
    if (pp <= 0) {
      showToast('Informe o preço de compra.');
      return;
    }
    await supplierRepository.addLink({ supplierId: id, productId: pickProductId, purchasePrice: pp });
    setPickProductId(undefined);
    setPrice('');
    reloadLinks();
    void runSync(); // reflete rápido no servidor/histórico (no-op offline)
    showToast('Produto associado! ✅');
  };

  const onInactivate = async (linkId: string) => {
    await supplierRepository.inactivateLink(linkId);
    reloadLinks();
    void runSync();
    showToast('Fornecedor inativado. O histórico foi preservado.');
  };

  const onDelete = (linkId: string, name: string) => {
    Alert.alert(
      'Excluir vínculo',
      `Excluir de vez o vínculo com "${name}"? Use isto só para corrigir um cadastro errado. Para troca de fornecedor, prefira Inativar.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: async () => {
            await supplierRepository.deleteLink(linkId);
            reloadLinks();
            void runSync();
            showToast('Vínculo excluído.');
          },
        },
      ],
    );
  };

  const onStartEdit = (l: ProductSupplier) => {
    setEditingId(l.id);
    setEditPrice(formatMoneyInput(l.purchasePrice));
  };

  const onSaveEdit = async () => {
    if (!editingId) return;
    const pp = parseBRL(editPrice);
    if (pp <= 0) {
      showToast('Informe o preço de compra.');
      return;
    }
    await supplierRepository.updateLink(editingId, { purchasePrice: pp });
    setEditingId(null);
    setEditPrice('');
    reloadLinks();
    void runSync();
    showToast('Preço atualizado! ✅');
  };

  // employee não acessa Fornecedores (guarda de deep-link; a RLS confirma no servidor).
  if (!canAccessSuppliers) return <Redirect href="/mais" />;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{supplier?.name ?? '—'}</Text>
      {!!supplier?.contactName && <Text style={styles.meta}>Contato: {supplier.contactName}</Text>}
      {!!supplier?.phone && <Text style={styles.meta}>Telefone: {supplier.phone}</Text>}
      {!!supplier?.address && <Text style={styles.meta}>Endereço: {supplier.address}</Text>}

      {canWriteSuppliers && (
        <Button
          title="Editar fornecedor"
          variant="outline"
          onPress={() => router.push({ pathname: '/mais/fornecedor-form', params: { id } })}
        />
      )}

      <Text style={styles.section}>Produtos fornecidos</Text>
      {links.length === 0 && <Text style={styles.hint}>Nenhum produto associado ainda.</Text>}
      {links.map((l) =>
        canWriteSuppliers && editingId === l.id ? (
          <View key={l.id} style={styles.editRow}>
            <Text style={styles.linkName}>{productName(l.productId)}</Text>
            <MoneyField label="Novo preço de compra (R$)" value={editPrice} onChangeText={setEditPrice} />
            <View style={styles.editActions}>
              <Button title="Salvar" onPress={onSaveEdit} />
              <Button title="Cancelar" variant="text" onPress={() => setEditingId(null)} />
            </View>
          </View>
        ) : (
          <View key={l.id} style={styles.linkRow}>
            <View style={styles.linkTop}>
              <Text style={styles.linkName}>{productName(l.productId)}</Text>
              <Text style={styles.linkPrice}>{formatBRL(l.purchasePrice)}</Text>
            </View>
            {canWriteSuppliers && (
              <View style={styles.linkActions}>
                <Pressable onPress={() => onStartEdit(l)} accessibilityLabel="Editar preço" hitSlop={8}>
                  <Text style={styles.edit}>Editar</Text>
                </Pressable>
                <Pressable onPress={() => onInactivate(l.id)} accessibilityLabel="Inativar fornecedor" hitSlop={8}>
                  <Text style={styles.inactivate}>Inativar</Text>
                </Pressable>
                <Pressable
                  onPress={() => onDelete(l.id, productName(l.productId))}
                  accessibilityLabel="Excluir vínculo"
                  hitSlop={8}
                >
                  <Text style={styles.remove}>Excluir</Text>
                </Pressable>
              </View>
            )}
          </View>
        ),
      )}

      {canWriteSuppliers && (
        <>
          <Text style={styles.section}>Associar produto</Text>
          {linkable.length === 0 ? (
            <Text style={styles.hint}>Todos os produtos já estão associados.</Text>
          ) : (
            <>
              <View style={styles.chips}>
                {linkable.map((p) => (
                  <Chip
                    key={p.id}
                    label={p.name}
                    selected={pickProductId === p.id}
                    onPress={() => setPickProductId(p.id)}
                  />
                ))}
              </View>
              <MoneyField label="Preço de compra (R$)" value={price} onChangeText={setPrice} />
              <Button title="Associar produto" onPress={onAddLink} />
            </>
          )}
        </>
      )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  meta: { color: colors.textSecondary, fontSize: 14 },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.lg },
  hint: { color: colors.textSecondary, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  linkRow: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.sm,
  },
  linkTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  linkActions: { flexDirection: 'row', gap: spacing.lg },
  linkName: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  linkPrice: { color: colors.gold, fontSize: 15, fontWeight: '700' },
  edit: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  inactivate: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  remove: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  editRow: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.sm,
  },
  editActions: { flexDirection: 'row', gap: spacing.sm },
});
