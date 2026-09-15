import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, radii, spacing } from '@/design/tokens';

type Props = {
  /** Linha 1: a escolha em si. */
  label: string;
  /** Linha 2: a consequência da escolha (tipicamente a data). */
  hint: string;
  selected: boolean;
  onPress: () => void;
  /**
   * Rótulo para o leitor de tela. Use a data POR EXTENSO aqui: o TalkBack lê
   * "28/09/2026" como uma sequência de dígitos soltos, e a informação mais
   * importante da tela se perde.
   */
  accessibilityLabel?: string;
};

/**
 * Escolha única (radio) em duas linhas. Não existia checkbox nem radio no repo —
 * o `Chip` é uma pílula curta e horizontal, que não comporta a linha de data e já
 * significa "filtro/tag" no app (categoria, dias da semana); e um `Switch` diria
 * "ligar/desligar um recurso", não "escolher entre dois desfechos com prazos
 * diferentes".
 *
 * Por que radio e não checkbox na tela de exclusão: um checkbox desmarcado esconde
 * a consequência mais grave — que desmarcar encurta o prazo de 10 dias úteis para
 * 48 horas. Com duas opções, cada uma carregando a própria data, as duas
 * consequências ficam legíveis ao mesmo tempo.
 */
export function OptionRow({ label, hint, selected, onPress, accessibilityLabel }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={accessibilityLabel ?? `${label}. ${hint}`}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && styles.pressed,
      ]}
    >
      {/* Círculo cheio, não "✓": comunica escolha única melhor que um check. */}
      <View style={[styles.marker, selected && styles.markerSelected]}>
        {selected && <View style={styles.dot} />}
      </View>
      <View style={styles.texts}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56, // a linha INTEIRA é o alvo de toque, não só o círculo
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
  },
  rowSelected: { borderColor: colors.gold, backgroundColor: colors.surfaceHover },
  pressed: { opacity: 0.85 },
  marker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.textSecondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  markerSelected: { borderColor: colors.gold },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.gold },
  texts: { flex: 1 },
  label: { color: colors.textPrimary, fontSize: fontSizes.body, fontWeight: '600' },
  hint: { color: colors.textSecondary, fontSize: fontSizes.label, lineHeight: 20, marginTop: 2 },
});
