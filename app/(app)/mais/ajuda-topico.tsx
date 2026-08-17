import { Redirect, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { HELP_TOPICS } from '@/content/help/topics';
import type { HelpRequirement } from '@/content/help/types';
import { colors, radii, spacing } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';
import { FlowChart } from '@/ui/flow/FlowChart';

export default function AjudaTopico() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { canAccessProducts, canAccessStock, canAccessSuppliers, canAccessReports } =
    usePermissions();

  const topic = HELP_TOPICS.find((t) => t.id === id);

  const allowed = (requires?: HelpRequirement): boolean => {
    if (requires === 'products') return canAccessProducts;
    if (requires === 'stock') return canAccessStock;
    if (requires === 'suppliers') return canAccessSuppliers;
    if (requires === 'reports') return canAccessReports;
    return true;
  };

  // Tópico inexistente ou fora do alcance do papel do usuário (guarda de deep-link).
  if (!topic || !allowed(topic.requires)) return <Redirect href="/mais/ajuda" />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{topic.title}</Text>
      <Text style={styles.intro}>{topic.intro}</Text>

      <Text style={styles.sectionTitle}>Fluxo</Text>
      <FlowChart nodes={topic.flow} />

      <Text style={styles.sectionTitle}>Passo a passo</Text>
      <View style={styles.steps}>
        {topic.steps.map((step) => (
          <View key={step.title} style={styles.stepCard}>
            <Text style={styles.stepTitle}>{step.title}</Text>
            <Text style={styles.stepDetail}>{step.detail}</Text>
          </View>
        ))}
      </View>

      {!!topic.tips?.length && (
        <>
          <Text style={styles.sectionTitle}>Dicas</Text>
          <View style={styles.tips}>
            {topic.tips.map((tip) => (
              <View key={tip} style={styles.tipRow}>
                <Text style={styles.tipBullet}>•</Text>
                <Text style={styles.tipText}>{tip}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700' },
  intro: { color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: spacing.md },
  sectionTitle: {
    color: colors.gold,
    fontSize: 16,
    fontWeight: '700',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  steps: { gap: spacing.sm },
  stepCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  stepTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '700' },
  stepDetail: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, marginTop: spacing.xs },
  tips: { gap: spacing.xs },
  tipRow: { flexDirection: 'row', gap: spacing.sm },
  tipBullet: { color: colors.gold, fontSize: 16 },
  tipText: { color: colors.textSecondary, fontSize: 15, lineHeight: 21, flex: 1 },
});
