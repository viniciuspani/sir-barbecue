import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { categoryRepository, productRepository } from '@/data/repositories';
import type { Category } from '@/domain/entities/Category';
import { colors, spacing } from '@/design/tokens';
import { formatMoneyInput, parseBRL } from '@/lib/currency';
import { WEEKDAYS_PT } from '@/lib/dates';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { MoneyField } from '@/ui/MoneyField';
import { TextField } from '@/ui/TextField';

export default function ProdutoForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!id;

  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState<string | undefined>();
  const [isActive, setIsActive] = useState(true);
  const [days, setDays] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => categoryRepository.observeAll(setCategories), []);

  useEffect(() => {
    if (!id) return;
    productRepository
      .getById(id)
      .then((p) => {
        if (!p) return;
        setName(p.name);
        setPrice(formatMoneyInput(p.price));
        setCategoryId(p.categoryId);
        setIsActive(p.isActive);
        setDays(p.visibleDays ?? []);
      })
      .catch(() => undefined);
  }, [id]);

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const onSave = async () => {
    setError(null);
    const parsedPrice = parseBRL(price);
    if (!name.trim()) {
      setError('Informe o nome do produto.');
      return;
    }
    if (parsedPrice <= 0) {
      setError('Informe um preço válido (maior que zero).');
      return;
    }
    setSaving(true);
    const payload = { name: name.trim(), price: parsedPrice, isActive, categoryId, visibleDays: days };
    if (isEdit && id) await productRepository.update(id, payload);
    else await productRepository.create(payload);
    setSaving(false);
    router.back();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BrandLogo />
        <Text style={styles.title}>{isEdit ? 'Editar produto' : 'Novo produto'}</Text>

        <TextField
          label="Nome"
          value={name}
          onChangeText={setName}
          placeholder="ex.: Espetinho de Carne"
          autoCapitalize="words"
        />
        <MoneyField label="Preço (R$)" value={price} onChangeText={setPrice} />

        <Text style={styles.section}>Categoria</Text>
        <View style={styles.chips}>
          {categories.length === 0 && <Text style={styles.hint}>Nenhuma categoria cadastrada.</Text>}
          {categories.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              selected={categoryId === c.id}
              onPress={() => setCategoryId(categoryId === c.id ? undefined : c.id)}
            />
          ))}
        </View>

        <Text style={styles.section}>
          Dias de visibilidade <Text style={styles.hint}>(nenhum = todos os dias)</Text>
        </Text>
        <View style={styles.chips}>
          {WEEKDAYS_PT.map((label, i) => (
            <Chip key={label} label={label.slice(0, 3)} selected={days.includes(i)} onPress={() => toggleDay(i)} />
          ))}
        </View>

        <View style={styles.switchRow}>
          <Text style={styles.section}>Produto ativo</Text>
          <Switch
            value={isActive}
            onValueChange={setIsActive}
            trackColor={{ true: colors.gold, false: colors.divider }}
            thumbColor={colors.textPrimary}
          />
        </View>

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Button
          title={isEdit ? 'Salvar alterações' : 'Cadastrar produto'}
          onPress={onSave}
          loading={saving}
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
  hint: { color: colors.textSecondary, fontSize: 13, fontWeight: '400' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  error: { color: colors.danger, fontSize: 14, marginVertical: spacing.sm },
});
