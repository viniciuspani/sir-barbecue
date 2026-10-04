import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { categoryRepository, productRepository, stockRepository, supplierRepository } from '@/data/repositories';
import type { Category } from '@/domain/entities/Category';
import type { ProductSupplier } from '@/domain/entities/ProductSupplier';
import type { Product } from '@/domain/entities/Product';
import type { Supplier } from '@/domain/entities/Supplier';
import { colors, spacing } from '@/design/tokens';
import { parseBRL, quantityValidationMessage, sanitizeQuantityInput } from '@/lib/currency';
import { reportError } from '@/lib/feedback';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { ProductPicker } from '@/ui/ProductPicker';
import { TextField } from '@/ui/TextField';

export default function RegistrarEntrada() {
  const { readOnlyReason } = usePermissions();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<string | undefined>();
  const [quantity, setQuantity] = useState('');
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [productSupplierLinks, setProductSupplierLinks] = useState<ProductSupplier[]>([]);
  const [supplierId, setSupplierId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => categoryRepository.observeAll(setCategories), []);
  useEffect(() => productRepository.observeAll(setProducts), []);
  useEffect(() => supplierRepository.observeAll(setSuppliers), []);

  // Fornecedores do lote (opcional) — só os já associados a ESTE produto, pra
  // não listar o fornecedor de outro produto por engano. Troca de produto
  // limpa a escolha: o fornecedor selecionado pode não servir mais.
  useEffect(() => {
    setSupplierId(undefined);
    if (!productId) {
      setProductSupplierLinks([]);
      return;
    }
    supplierRepository.listLinksByProduct(productId).then(setProductSupplierLinks).catch(() => {});
  }, [productId]);

  const linkedSupplierNames = productSupplierLinks
    .map((l) => ({ link: l, name: suppliers.find((s) => s.id === l.supplierId)?.name }))
    .filter((x): x is { link: ProductSupplier; name: string } => !!x.name);

  const onChangeQuantity = (t: string) => {
    setQuantity(sanitizeQuantityInput(t));
    if (quantityError) setQuantityError(null);
  };

  // Roda ao sair do campo (feedback imediato) e de novo ao salvar — mesmo
  // padrão do CNPJ/Telefone em Minha Empresa e do preço em Produto/Fornecedor.
  const validateQuantity = (): string | null => {
    const qty = parseBRL(quantity);
    const message = qty <= 0 ? 'Informe uma quantidade válida.' : quantityValidationMessage(qty);
    setQuantityError(message);
    return message;
  };

  const onSave = async () => {
    setError(null);
    if (!productId) {
      setError('Selecione o produto.');
      return;
    }
    const quantityMessage = validateQuantity();
    if (quantityMessage) {
      showToast(quantityMessage);
      return;
    }
    const qty = parseBRL(quantity);
    setSaving(true);
    try {
      await stockRepository.registerEntry({
        productId,
        quantity: qty,
        notes: notes.trim() || undefined,
        supplierId,
      });
      showToast('Entrada registrada! ✅');
      router.back();
    } catch (e) {
      await reportError(e, { action: 'Registrar entrada de estoque', meta: { productId, qty } });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandLogo />
        <Text style={styles.title}>Registrar entrada</Text>

        <Text style={styles.section}>Produto</Text>
        {products.length === 0 ? (
          <Text style={styles.hint}>Nenhum produto cadastrado.</Text>
        ) : (
          <ProductPicker
            products={products}
            categories={categories}
            selectedId={productId}
            onSelect={setProductId}
          />
        )}

        <TextField
          label="Quantidade"
          value={quantity}
          onChangeText={onChangeQuantity}
          onBlur={validateQuantity}
          placeholder="ex.: 50"
          keyboardType="decimal-pad"
          error={quantityError ?? undefined}
        />
        <TextField
          label="Observações — opcional"
          value={notes}
          onChangeText={setNotes}
          placeholder="ex.: compra no atacado"
        />

        {!!productId && (
          <>
            <Text style={styles.section}>Fornecedor do lote — opcional</Text>
            {linkedSupplierNames.length === 0 ? (
              <Text style={styles.hint}>
                Nenhum fornecedor cadastrado para este produto.{' '}
                <Text style={styles.hintLink} onPress={() => router.push('/mais/fornecedores')}>
                  Cadastrar fornecedor
                </Text>
              </Text>
            ) : (
              <>
                <View style={styles.supplierRow}>
                  {linkedSupplierNames.map(({ link, name }) => (
                    <Chip
                      key={link.id}
                      label={name}
                      selected={supplierId === link.supplierId}
                      onPress={() => setSupplierId(supplierId === link.supplierId ? undefined : link.supplierId)}
                    />
                  ))}
                </View>
                <Text style={styles.hint}>
                  Só pra saber de onde veio o lote — o preço continua vindo do cadastro do fornecedor.
                </Text>
              </>
            )}
          </>
        )}

        <Text style={styles.hint}>
          O custo do produto é cadastrado no fornecedor, não aqui.{' '}
          <Text style={styles.hintLink} onPress={() => router.push('/mais/fornecedores')}>
            Cadastrar preço de compra
          </Text>
        </Text>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Button
          title="Registrar entrada"
          onPress={onSave}
          loading={saving}
          disabledReason={readOnlyReason ?? undefined}
        />
        <Button title="Cancelar" variant="text" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700', marginBottom: spacing.md },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.sm },
  hint: { color: colors.textSecondary, fontSize: 13 },
  hintLink: { color: colors.gold, fontWeight: '600' },
  supplierRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  error: { color: colors.danger, fontSize: 14, marginVertical: spacing.sm },
});
