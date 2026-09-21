import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Category } from '@/domain/entities/Category';
import type { Product } from '@/domain/entities/Product';
import { colors, spacing } from '@/design/tokens';
import { matchesSearch } from '@/lib/search';

import { Chip } from './Chip';
import { TextField } from './TextField';

// Sentinela para "sem categoria" no filtro — não é um id de categoria real.
const UNCATEGORIZED = '__uncategorized__';

type Props = {
  products: Product[];
  categories: Category[];
  selectedId?: string;
  onSelect: (id: string) => void;
};

/**
 * Busca + filtro de categoria + lista de produtos. Assume `products` já
 * não-vazio — o chamador decide a mensagem de "lista vazia" (o motivo varia:
 * "nenhum produto cadastrado" vs. "todos já associados"), este componente só
 * cuida do caso "o filtro não encontrou nada".
 */
export function ProductPicker({ products, categories, selectedId, onSelect }: Props) {
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();
  const [search, setSearch] = useState('');

  const hasUncategorized = useMemo(() => products.some((p) => !p.categoryId), [products]);

  // Categoria restringe, busca refina dentro do que sobrou (E lógico) — assim o
  // operador pode navegar por categoria (dedo rápido) ou digitar o nome, sem um
  // fluxo atrapalhar o outro.
  const filtered = useMemo(() => {
    return products
      .filter((p) => {
        if (!categoryFilter) return true;
        if (categoryFilter === UNCATEGORIZED) return !p.categoryId;
        return p.categoryId === categoryFilter;
      })
      .filter((p) => matchesSearch(p.name, search));
  }, [products, categoryFilter, search]);

  return (
    <>
      <TextField label="Buscar produto" value={search} onChangeText={setSearch} placeholder="ex.: queijo" />
      {categories.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.categoryRow}
          contentContainerStyle={styles.categoryRowContent}
        >
          <Chip label="Todas" selected={!categoryFilter} onPress={() => setCategoryFilter(undefined)} />
          {categories.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              selected={categoryFilter === c.id}
              onPress={() => setCategoryFilter(c.id)}
            />
          ))}
          {hasUncategorized && (
            <Chip
              label="Sem categoria"
              selected={categoryFilter === UNCATEGORIZED}
              onPress={() => setCategoryFilter(UNCATEGORIZED)}
            />
          )}
        </ScrollView>
      )}
      <View style={styles.chips}>
        {filtered.length === 0 && <Text style={styles.hint}>Nenhum produto encontrado com esse filtro.</Text>}
        {filtered.map((p) => (
          <Chip key={p.id} label={p.name} selected={selectedId === p.id} onPress={() => onSelect(p.id)} />
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  categoryRow: { marginBottom: spacing.sm },
  categoryRowContent: { gap: spacing.sm, paddingRight: spacing.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  hint: { color: colors.textSecondary, fontSize: 13 },
});
