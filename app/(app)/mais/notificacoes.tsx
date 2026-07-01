import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { showToast } from '@/lib/toast';
import { registerAndSavePushToken } from '@/services/push';
import { Button } from '@/ui/Button';

export default function Notificacoes() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onEnable = async () => {
    setLoading(true);
    const { token: result, error } = await registerAndSavePushToken({ prompt: true });
    setToken(result);
    setLoading(false);
    showToast(error ?? 'Notificações ativadas!');
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.p}>
        As notificações avisam sobre <Text style={styles.b}>estoque baixo</Text> (RF-11) e{' '}
        <Text style={styles.b}>relatórios prontos</Text> (RF-22).
      </Text>

      <Button title="Ativar notificações" onPress={onEnable} loading={loading} />

      {token != null && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Token do dispositivo</Text>
          <Text style={styles.cardValue} numberOfLines={2}>
            {token}
          </Text>
        </View>
      )}

      <Text style={styles.hint}>
        O envio de push exige um development build (não Expo Go) e o backend para disparar (registro
        do token + Edge Function/cron) — follow-up do backend. Os alertas de estoque baixo também
        aparecem na tela Início.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  p: { color: colors.textPrimary, fontSize: 15, lineHeight: 22 },
  b: { fontWeight: '700', color: colors.gold },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  cardLabel: { color: colors.textSecondary, fontSize: 13 },
  cardValue: { color: colors.textPrimary, fontSize: 13, marginTop: spacing.xs, fontFamily: 'monospace' },
  hint: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
});
