import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { showToast } from '@/lib/toast';
import { deleteAccount } from '@/services/functions';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';

export default function Perfil() {
  const user = useAuthStore((s) => s.user);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const signOut = useAuthStore((s) => s.signOut);

  const onLogout = () => {
    Alert.alert('Sair', 'Deseja sair da sua conta?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        onPress: () => {
          void signOut(); // o gate redireciona para o login ao limpar a sessão
        },
      },
    ]);
  };

  // RNF-08: exclusão definitiva via Edge Function delete-account (apaga usuário + dados da empresa).
  const onDelete = () => {
    Alert.alert(
      'Excluir conta',
      'Esta ação remove sua conta e os dados da empresa de forma permanente. É irreversível.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: () => void doDelete() },
      ],
    );
  };

  const doDelete = async () => {
    const { error } = await deleteAccount();
    if (error) {
      showToast(error);
      return;
    }
    showToast('Conta excluída.');
    await signOut();
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.label}>E-mail</Text>
        <Text style={styles.value}>{user?.email ?? '—'}</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Empresa ativa</Text>
        <Text style={styles.value}>{currentTenantId ? 'Vinculada ✓' : 'Aguardando 1º sync online'}</Text>
      </View>

      <View style={styles.actions}>
        <Button title="Sair da conta" variant="outline" onPress={onLogout} />
        <Button title="Excluir conta" variant="text" onPress={onDelete} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  label: { color: colors.textSecondary, fontSize: 13 },
  value: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.xs },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
});
