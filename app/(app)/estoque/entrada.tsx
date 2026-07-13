import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { productRepository, stockRepository } from '@/data/repositories';
import type { Product } from '@/domain/entities/Product';
import { colors, spacing } from '@/design/tokens';
import { parseBRL } from '@/lib/currency';
import { showToast } from '@/lib/toast';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { MoneyField } from '@/ui/MoneyField';
import { TextField } from '@/ui/TextField';

export default function RegistrarEntrada() {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<string | undefined>();
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => productRepository.observeAll(setProducts), []);

  const onSave = async () => {
    setError(null);
    const qty = parseBRL(quantity); // aceita "50" ou "2,5"
    if (!productId) {
      setError('Selecione o produto.');
      return;
    }
    if (qty <= 0) {
      setError('Informe uma quantidade válida.');
      return;
    }
    setSaving(true);
    await stockRepository.registerEntry({
      productId,
      quantity: qty,
      unitCost: unitCost.trim() ? parseBRL(unitCost) : undefined,
      notes: notes.trim() || undefined,
    });
    setSaving(false);
    showToast('Entrada registrada! ✅');
    router.back();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandLogo />
        <Text style={styles.title}>Registrar entrada</Text>

        <Text style={styles.section}>Produto</Text>
        <View style={styles.chips}>
          {products.length === 0 && <Text style={styles.hint}>Nenhum produto cadastrado.</Text>}
          {products.map((p) => (
            <Chip
              key={p.id}
              label={p.name}
              selected={productId === p.id}
              onPress={() => setProductId(p.id)}
            />
          ))}
        </View>

        <TextField
          label="Quantidade"
          value={quantity}
          onChangeText={setQuantity}
          placeholder="ex.: 50"
          keyboardType="decimal-pad"
        />
        <MoneyField
          label="Custo unitário (R$) — opcional"
          value={unitCost}
          onChangeText={setUnitCost}
        />
        <TextField
          label="Observações — opcional"
          value={notes}
          onChangeText={setNotes}
          placeholder="ex.: compra no atacado"
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Button title="Registrar entrada" onPress={onSave} loading={saving} />
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  error: { color: colors.danger, fontSize: 14, marginVertical: spacing.sm },
});
