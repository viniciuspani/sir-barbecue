import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';

/**
 * Tela de bloqueio para usuário AUTENTICADO mas SEM vínculo com nenhuma empresa
 * (não foi convidado). Impede o acesso a qualquer tela operacional (Venda etc.) —
 * a trava real é o guard de escrita + o filtro de sync, esta tela é a barreira de UI.
 * Espelha o padrão de src/ui/AccessBlocked.tsx.
 */
export function MembershipRequired() {
  const signOut = useAuthStore((s) => s.signOut);

  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        <Ionicons name="business-outline" size={48} color={colors.gold} />
      </View>

      <Text style={styles.brand}>Sir Barbecue</Text>
      <Text style={styles.title}>Conta sem empresa</Text>
      <Text style={styles.body}>
        Sua conta ainda não está vinculada a nenhuma empresa. Peça ao administrador que envie um
        convite para o seu e-mail e faça login novamente.
      </Text>

      <Button
        title="Sair"
        variant="outline"
        onPress={() => void signOut()}
        style={styles.button}
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
});
