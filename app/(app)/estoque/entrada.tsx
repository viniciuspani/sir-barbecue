import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { categoryRepository, productRepository, stockRepository } from '@/data/repositories';
import type { Category } from '@/domain/entities/Category';
import type { Product } from '@/domain/entities/Product';
import { colors, spacing } from '@/design/tokens';
import { parseBRL, quantityValidationMessage, sanitizeQuantityInput } from '@/lib/currency';
import { reportError } from '@/lib/feedback';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => categoryRepository.observeAll(setCategories), []);
  useEffect(() => productRepository.observeAll(setProducts), []);

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
  error: { color: colors.danger, fontSize: 14, marginVertical: spacing.sm },
});
