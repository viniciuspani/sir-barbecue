import { StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';

type Props = {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  minimumDate?: Date;
  maximumDate?: Date;
};

function toInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Campo de data na web: `<input type="date">` nativo do navegador (sem calendário custom). */
export function DateField({ label, value, onChange, minimumDate, maximumDate }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <input
        type="date"
        value={toInputValue(value)}
        min={minimumDate ? toInputValue(minimumDate) : undefined}
        max={maximumDate ? toInputValue(maximumDate) : undefined}
        onChange={(e) => {
          const [y, m, d] = e.target.value.split('-').map(Number);
          if (!y || !m || !d) return;
          onChange(new Date(y, m - 1, d));
        }}
        style={{
          backgroundColor: colors.surface,
          color: colors.textPrimary,
          border: `1.5px solid ${colors.divider}`,
          borderRadius: radii.md,
          padding: `${spacing.sm + 4}px ${spacing.md}px`,
          fontSize: 15,
          fontWeight: 600,
          colorScheme: 'dark',
          width: '100%',
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  label: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.xs },
});
