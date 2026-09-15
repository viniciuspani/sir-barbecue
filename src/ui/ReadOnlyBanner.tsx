import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/design/tokens';
import { formatIsoDate } from '@/lib/dates';
import { useAccessStore } from '@/store/accessStore';
import { useConnectivityStore } from '@/store/connectivityStore';

/**
 * Faixa fixa do modo SOMENTE-LEITURA (exclusão de conta agendada, MIGRATION_24).
 * Mora abaixo do OfflineBanner, no layout do grupo autenticado.
 *
 * Amarelo, não vermelho: `red` já é a faixa de offline (mesmo lugar da tela) e
 * `danger` significa destruição irreversível. Uma faixa vermelha permanente e
 * colada na de offline vira ruído e sugere que a conta JÁ foi apagada — o oposto
 * da mensagem, já que até a data ainda dá para cancelar. Amarelo é o token de
 * alerta que o app já usa no estoque baixo: "tem prazo, ainda dá para agir".
 * Contraste do texto escuro sobre o amarelo: 7,95:1.
 *
 * Não fecha e não tem botão: a ação mora no card da Home, com espaço para
 * explicar. Aqui é só o estado, presente em todas as telas.
 */
export function ReadOnlyBanner() {
  const readOnly = useAccessStore((s) => s.readOnly);
  const deletion = useAccessStore((s) => s.deletion);
  const isOnline = useConnectivityStore((s) => s.isOnline);
  const insets = useSafeAreaInsets();

  if (!readOnly) return null;

  // O OfflineBanner já consumiu o inset quando está visível; somar de novo
  // empurraria esta faixa para baixo e deixaria um vão vermelho no meio.
  const paddingTop = isOnline ? insets.top + 6 : 6;

  const date = deletion?.scheduledFor ? formatIsoDate(deletion.scheduledFor) : null;
  const text =
    deletion?.canCancel && date
      ? `Somente consulta — exclusão em ${date}`
      : 'Somente consulta — o dono pediu a exclusão da conta';

  return (
    <View
      style={[styles.banner, { paddingTop }]}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.yellow, paddingHorizontal: 16, paddingBottom: 6 },
  text: { color: colors.bg, fontSize: 13, fontWeight: '700', textAlign: 'center' },
});
