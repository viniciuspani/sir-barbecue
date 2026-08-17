import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { HELP_TOPICS } from '@/content/help/topics';
import type { HelpRequirement } from '@/content/help/types';
import { colors, radii, spacing } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';

export default function Ajuda() {
  const { canAccessProducts, canAccessStock, canAccessSuppliers, canAccessReports } =
    usePermissions();

  const allowed = (requires?: HelpRequirement): boolean => {
    if (requires === 'products') return canAccessProducts;
    if (requires === 'stock') return canAccessStock;
    if (requires === 'suppliers') return canAccessSuppliers;
    if (requires === 'reports') return canAccessReports;
    return true;
  };

  const topics = HELP_TOPICS.filter((t) => allowed(t.requires));

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Um passo a passo simples para cada tarefa do dia a dia, com o caminho certo dentro do
        aplicativo.
      </Text>

      {canAccessProducts && canAccessStock && (
        <View style={styles.startCard}>
          <Text style={styles.startTitle}>Começando do zero?</Text>
          <Text style={styles.startText}>
            Siga esta ordem: cadastre o produto → coloque no estoque → venda.
          </Text>
        </View>
      )}

      {topics.map((topic) => (
        <Pressable
          key={topic.id}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => router.push({ pathname: '/mais/ajuda-topico', params: { id: topic.id } })}
          accessibilityRole="button"
          accessibilityLabel={topic.title}
        >
          <Ionicons name={topic.icon} size={22} color={colors.gold} />
          <View style={styles.rowText}>
            <Text style={styles.label}>{topic.title}</Text>
            <Text style={styles.hint}>{topic.subtitle}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  intro: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  startCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  startTitle: { color: colors.gold, fontSize: 15, fontWeight: '700' },
  startText: { color: colors.textPrimary, fontSize: 15, lineHeight: 21, marginTop: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  pressed: { opacity: 0.85 },
  rowText: { flex: 1 },
  label: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
});
