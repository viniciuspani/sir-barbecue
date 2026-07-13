import { Ionicons } from '@expo/vector-icons';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import type { AccessReason } from '@/services/access';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';

type Copy = { icon: keyof typeof Ionicons.glyphMap; title: string; body: string };

const COPY: Record<string, Copy> = {
  trial_expired: {
    icon: 'time-outline',
    title: 'Período de teste encerrado',
    body: 'Seu período de avaliação chegou ao fim. Assine para continuar usando o aplicativo.',
  },
  payment_overdue: {
    icon: 'card-outline',
    title: 'Pagamento em atraso',
    body: 'Identificamos uma pendência na sua assinatura. Regularize o pagamento para reativar o acesso.',
  },
  canceled: {
    icon: 'close-circle-outline',
    title: 'Assinatura cancelada',
    body: 'Sua assinatura foi cancelada. Fale com o suporte para reativar o aplicativo.',
  },
  blocked_by_owner: {
    icon: 'lock-closed-outline',
    title: 'Acesso suspenso',
    body: 'O acesso a este aplicativo foi suspenso. Entre em contato com o suporte.',
  },
  default: {
    icon: 'alert-circle-outline',
    title: 'Acesso indisponível',
    body: 'Não foi possível validar seu acesso. Verifique sua conexão e tente novamente.',
  },
};

export function AccessBlocked({ reason }: { reason: AccessReason | null }) {
  const signOut = useAuthStore((s) => s.signOut);
  const contact = process.env.EXPO_PUBLIC_SUPPORT_CONTACT;
  const copy = (reason && COPY[reason]) || COPY.default;

  const openContact = () => {
    if (!contact) return;
    const url = contact.includes('@')
      ? `mailto:${contact}`
      : `https://wa.me/${contact.replace(/\D/g, '')}`;
    void Linking.openURL(url);
  };

  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        <Ionicons name={copy.icon} size={48} color={colors.gold} />
      </View>

      <Text style={styles.brand}>Sir Barbecue</Text>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>

      {contact ? (
        <Button title="Falar com o suporte" onPress={openContact} style={styles.button} />
      ) : null}
      <Button
        title="Sair"
        variant="outline"
        onPress={() => void signOut()}
        style={styles.buttonSecondary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    marginBottom: spacing.xl,
  },
  brand: { color: colors.gold, fontSize: 28, fontWeight: '700', marginBottom: spacing.sm },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  body: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  button: { marginTop: spacing.xl, alignSelf: 'stretch' },
  buttonSecondary: { marginTop: spacing.md, alignSelf: 'stretch' },
});
