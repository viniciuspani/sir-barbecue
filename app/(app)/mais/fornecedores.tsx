import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { supplierRepository } from '@/data/repositories';
import type { Supplier } from '@/domain/entities/Supplier';
import { colors, radii, spacing } from '@/design/tokens';

export default function Fornecedores() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  useEffect(() => supplierRepository.observeAll(setSuppliers), []);

  return (
    <View style={styles.container}>
      <FlatList
        data={suppliers}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.empty}>Nenhum fornecedor. Toque em “+” para cadastrar.</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              router.push({ pathname: '/mais/fornecedor-detalhe', params: { id: item.id } })
            }
            accessibilityRole="button"
            accessibilityLabel={item.name}
          >
            <View style={styles.rowMain}>
              <Text style={styles.name}>{item.name}</Text>
              {(item.contactName || item.phone) && (
                <Text style={styles.meta}>
                  {item.contactName ?? ''}
                  {item.contactName && item.phone ? ' · ' : ''}
                  {item.phone ?? ''}
                </Text>
              )}
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Pressable>
        )}
      />
      <Pressable
        style={styles.fab}
        onPress={() => router.push('/mais/fornecedor-form')}
        accessibilityRole="button"
        accessibilityLabel="Novo fornecedor"
      >
        <Ionicons name="add" size={28} color={colors.onGold} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, paddingBottom: 96, gap: spacing.sm },
  empty: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', marginTop: spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  rowMain: { flex: 1 },
  name: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
});
