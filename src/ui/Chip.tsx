import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';

type Props = {
  label: string;
  selected?: boolean;
  onPress: () => void;
};

/** Pílula selecionável — usada em categoria e dias de visibilidade. */
export function Chip({ label, selected, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
  },
  selected: { borderColor: colors.gold, backgroundColor: colors.gold },
  pressed: { opacity: 0.8 },
  label: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  labelSelected: { color: colors.onGold },
});
