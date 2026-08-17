import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { FlowArrow } from '@/ui/flow/FlowArrow';

export type FlowNode =
  | { kind: 'start' | 'end'; label: string }
  | { kind: 'step'; label: string; detail?: string; icon?: keyof typeof Ionicons.glyphMap }
  | { kind: 'decision'; label: string; yes: string; no: string };

type Props = {
  nodes: FlowNode[];
};

/** Fluxograma vertical: nós em View/Text (altura automática) ligados por setas SVG. */
export function FlowChart({ nodes }: Props) {
  return (
    <View style={styles.container}>
      {nodes.map((node, index) => (
        <View key={index} style={styles.item}>
          <FlowNodeView node={node} />
          {index < nodes.length - 1 && <FlowArrow />}
        </View>
      ))}
    </View>
  );
}

function FlowNodeView({ node }: { node: FlowNode }) {
  switch (node.kind) {
    case 'start':
    case 'end':
      return (
        <View style={[styles.pill, node.kind === 'start' ? styles.pillStart : styles.pillEnd]}>
          <Text style={styles.pillText}>{node.label}</Text>
        </View>
      );
    case 'decision':
      return (
        <View style={styles.decisionCard}>
          <View style={styles.decisionHeader}>
            <Ionicons name="help-circle-outline" size={20} color={colors.yellow} />
            <Text style={styles.decisionLabel}>{node.label}</Text>
          </View>
          <View style={styles.decisionBranches}>
            <Text style={styles.decisionBranch}>Sim → {node.yes}</Text>
            <Text style={styles.decisionBranch}>Não → {node.no}</Text>
          </View>
        </View>
      );
    case 'step':
      return (
        <View style={styles.stepCard}>
          {node.icon && (
            <Ionicons name={node.icon} size={20} color={colors.gold} style={styles.stepIcon} />
          )}
          <View style={styles.stepTextWrap}>
            <Text style={styles.stepLabel}>{node.label}</Text>
            {!!node.detail && <Text style={styles.stepDetail}>{node.detail}</Text>}
          </View>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  container: { alignItems: 'stretch' },
  item: { alignItems: 'center' },
  pill: {
    alignSelf: 'center',
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  pillStart: { backgroundColor: colors.green },
  pillEnd: { backgroundColor: colors.gold },
  pillText: { color: colors.onGold, fontSize: 16, fontWeight: '700' },
  stepCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radii.md,
    padding: spacing.md,
    width: '100%',
  },
  stepIcon: { marginTop: 2 },
  stepTextWrap: { flex: 1 },
  stepLabel: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  stepDetail: { color: colors.textSecondary, fontSize: 16, marginTop: 2, lineHeight: 22 },
  decisionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.yellow,
    borderRadius: radii.md,
    padding: spacing.md,
    width: '100%',
    gap: spacing.xs,
  },
  decisionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  decisionLabel: { color: colors.textPrimary, fontSize: 16, fontWeight: '700', flex: 1 },
  decisionBranches: { gap: 2 },
  decisionBranch: { color: colors.textSecondary, fontSize: 16, lineHeight: 22 },
});
