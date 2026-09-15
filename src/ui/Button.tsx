import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { colors, radii } from '@/design/tokens';
import { showToast } from '@/lib/toast';

type Variant = 'gold' | 'outline' | 'text' | 'danger';

type Props = {
  title: string;
  onPress: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  /**
   * Botão INERTE, e não mudo: fica com a aparência de desabilitado, mas continua
   * respondendo ao toque — e o toque mostra este motivo em vez de agir. Usado no
   * modo somente-leitura (exclusão de conta agendada).
   *
   * Um `disabled` puro não dispara `onPress`: a pessoa toca três vezes e conclui
   * que o app travou, e liga para o suporte. Esconder o botão é pior ainda —
   * parece que os dados sumiram.
   */
  disabledReason?: string;
  style?: ViewStyle;
};

export function Button({
  title,
  onPress,
  variant = 'gold',
  loading,
  disabled,
  disabledReason,
  style,
}: Props) {
  const inert = !!disabledReason && !disabled && !loading;
  const isDisabled = disabled || loading;
  const looksDisabled = isDisabled || inert;
  const spinnerColor = variant === 'gold' || variant === 'danger' ? colors.onGold : colors.gold;

  return (
    <Pressable
      onPress={inert ? () => showToast(disabledReason) : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      // O leitor de tela anuncia "desativado" + o motivo sem precisar tocar.
      accessibilityState={{ disabled: looksDisabled }}
      accessibilityHint={inert ? disabledReason : undefined}
      style={({ pressed }) => [
        styles.base,
        variant === 'gold' && styles.gold,
        variant === 'outline' && styles.outline,
        variant === 'text' && styles.textVariant,
        variant === 'danger' && styles.danger,
        looksDisabled && styles.disabled,
        pressed && !looksDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={spinnerColor} />
      ) : (
        <Text
          style={[
            styles.label,
            variant === 'gold' && styles.labelGold,
            variant === 'danger' && styles.labelDanger,
            (variant === 'outline' || variant === 'text') && styles.labelAccent,
          ]}
        >
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
  // Destrutivo: fundo vermelho com texto branco (contraste 9,2:1). Antes, a ação
  // mais consequente do app era um `variant="text"` com rótulo DOURADO — a mesma
  // cor de "confirmar" do resto do app.
  danger: { backgroundColor: colors.red },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  label: { fontSize: 18, fontWeight: '700' },
  labelGold: { color: colors.onGold },
  labelDanger: { color: colors.textPrimary },
  labelAccent: { color: colors.gold },
});
