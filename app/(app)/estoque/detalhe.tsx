import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { productRepository, stockRepository } from '@/data/repositories';
import type { StockEntry } from '@/domain/entities/StockEntry';
import { colors, radii, spacing } from '@/design/tokens';
import { formatBRL, formatQuantity, parseBRL } from '@/lib/currency';
import { formatDatePtBR } from '@/lib/dates';
import { showToast } from '@/lib/toast';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

export default function EstoqueDetalhe() {
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  const [productName, setProductName] = useState('—');
  const [quantity, setQuantity] = useState(0);
  const [threshold, setThreshold] = useState('');
  const [entries, setEntries] = useState<StockEntry[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!productId) return;
    productRepository
      .getById(productId)
      .then((p) => {
        if (p) setProductName(p.name);
      })
      .catch(() => undefined);
    stockRepository
      .getItem(productId)
      .then((it) => {
        if (it) {
          setQuantity(it.quantity);
          setThreshold(it.alertThreshold > 0 ? String(it.alertThreshold) : '');
        }
      })
      .catch(() => undefined);
    stockRepository.listEntries(productId).then(setEntries).catch(() => undefined);
  }, [productId]);

  const onSaveAlert = async () => {
    if (!productId) return;
    setSaving(true);
    await stockRepository.setAlertThreshold(productId, parseBRL(threshold));
    setSaving(false);
    showToast('Alerta atualizado! ✅');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{productName}</Text>

        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Saldo atual</Text>
          <Text style={styles.balanceValue}>{formatQuantity(quantity)}</Text>
        </View>

        <Text style={styles.section}>Alerta de estoque baixo</Text>
        <Text style={styles.hint}>Avisa quando o saldo ficar igual ou abaixo deste valor (0 = sem alerta).</Text>
        <TextField
          label="Limite de alerta"
          value={threshold}
          onChangeText={setThreshold}
          placeholder="ex.: 10"
          keyboardType="decimal-pad"
        />
        <Button title="Salvar alerta" onPress={onSaveAlert} loading={saving} />

        <Text style={styles.section}>Histórico de entradas</Text>
        {entries.length === 0 && <Text style={styles.hint}>Nenhuma entrada registrada.</Text>}
        {entries.map((e) => (
          <View key={e.id} style={styles.entry}>
            <View style={styles.entryMain}>
              <Text style={styles.entryQty}>+{formatQuantity(e.quantity)}</Text>
              <Text style={styles.entryDate}>{formatDatePtBR(new Date(e.entryDate))}</Text>
            </View>
            <Text style={styles.entryCost}>{e.unitCost != null ? formatBRL(e.unitCost) : '—'}</Text>
          </View>
        ))}

        <Button title="Voltar" variant="text" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  balanceCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    marginVertical: spacing.md,
  },
  balanceLabel: { color: colors.textSecondary, fontSize: 14 },
  balanceValue: { color: colors.gold, fontSize: 36, fontWeight: '700', marginTop: spacing.xs },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.lg },
  hint: { color: colors.textSecondary, fontSize: 13 },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  entryMain: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  entryQty: { color: colors.green, fontSize: 16, fontWeight: '700' },
  entryDate: { color: colors.textSecondary, fontSize: 13 },
  entryCost: { color: colors.textPrimary, fontSize: 14 },
});
