import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { colors, radii } from '@/design/tokens';

type Variant = 'gold' | 'outline' | 'text';

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

export function Button({ title, onPress, variant = 'gold', loading, disabled, style }: Props) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.base,
        variant === 'gold' && styles.gold,
        variant === 'outline' && styles.outline,
        variant === 'text' && styles.textVariant,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'gold' ? colors.onGold : colors.gold} />
      ) : (
        <Text style={[styles.label, variant === 'gold' ? styles.labelGold : styles.labelAccent]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    flexDirection: 'row',
  },
  gold: { backgroundColor: colors.gold },
  outline: { borderWidth: 2, borderColor: colors.gold, backgroundColor: 'transparent' },
  textVariant: { backgroundColor: 'transparent', minHeight: 44 },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  label: { fontSize: 18, fontWeight: '700' },
  labelGold: { color: colors.onGold },
  labelAccent: { color: colors.gold },
});
