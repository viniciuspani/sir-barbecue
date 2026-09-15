import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, radii, spacing } from '@/design/tokens';
import { formatIsoDate } from '@/lib/dates';
import { showToast } from '@/lib/toast';
import { useAccessStore } from '@/store/accessStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';

/**
 * Aviso de exclusão agendada, com a saída junto: é o card que sustenta a janela
 * de arrependimento. Usado na Home e dentro do AccessBlocked.
 *
 * Amarelo e não vermelho — ver o comentário do ReadOnlyBanner. O botão, ao
 * contrário, é DOURADO: cancelar é a ação desejada, e a cor de confirmação do app
 * é o dourado. Pintá-lo de vermelho ensinaria a coisa errada.
 *
 * `compact` encolhe o texto para caber dentro do AccessBlocked, onde o card é uma
 * saída de emergência e não o assunto da tela.
 */
export function DeletionNoticeCard({ compact = false }: { compact?: boolean }) {
  const deletion = useAccessStore((s) => s.deletion);
  const cancelDeletion = useAccessStore((s) => s.cancelDeletion);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const [canceling, setCanceling] = useState(false);

  if (!deletion) return null;

  const date = formatIsoDate(deletion.scheduledFor);

  const onCancel = () => {
    Alert.alert(
      'Cancelar a solicitação?',
      'Sua conta continua ativa e o app volta a funcionar normalmente. Nada foi excluído.',
      [
        { text: 'Voltar', style: 'cancel' },
        // Sem `destructive`: esta é a ação boa.
        {
          text: 'Cancelar solicitação',
          onPress: () => {
            if (!currentTenantId) return;
            setCanceling(true);
            void (async () => {
              const { error } = await cancelDeletion(currentTenantId);
              setCanceling(false);
              showToast(error ?? 'Solicitação cancelada. O app voltou ao normal.');
            })();
          },
        },
      ],
    );
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>⏱ Sua conta será excluída em {date}</Text>

      {!compact && (
        <>
          <Text style={styles.body}>
            {deletion.exportRequested
              ? `Enviamos o arquivo com seus dados para ${deletion.contactEmail ?? 'o seu e-mail'} em ${date}.`
              : 'Você optou por não receber uma cópia dos dados.'}
          </Text>
          <Text style={styles.body}>
            Até lá você consegue consultar tudo, mas não registrar vendas nem editar cadastros.
          </Text>
        </>
      )}

      {deletion.canCancel && (
        <Button
          title={compact ? 'Cancelar solicitação de exclusão' : 'Cancelar solicitação e voltar a usar'}
          variant={compact ? 'outline' : 'gold'}
          onPress={onCancel}
          loading={canceling}
          style={styles.button}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.yellow,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  title: { color: colors.yellow, fontSize: fontSizes.body, fontWeight: '700' },
  body: { color: colors.textSecondary, fontSize: fontSizes.label, lineHeight: 20 },
  button: { marginTop: spacing.xs },
});
