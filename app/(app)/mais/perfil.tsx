import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { showToast } from '@/lib/toast';
import { usesPasswordLogin } from '@/services/auth';
import { deleteAccount } from '@/services/functions';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

export default function Perfil() {
  const user = useAuthStore((s) => s.user);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const signOut = useAuthStore((s) => s.signOut);
  // A exclusão passou a ter dois passos: abrir o painel e confirmar.
  const [confirming, setConfirming] = useState(false);
  const [proof, setProof] = useState('');
  const [deleting, setDeleting] = useState(false);
  // Conta do Google não tem senha no Supabase Auth: a confirmação dela é
  // digitar o próprio e-mail. Ver usesPasswordLogin.
  const byPassword = usesPasswordLogin(user);

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
  //
  // Antes bastava confirmar um Alert: quem estivesse com o aparelho destravado
  // apagava a empresa inteira, junto com o trabalho de todos os funcionários,
  // sem desfazer. Agora exige uma prova, que a Edge Function revalida no
  // servidor antes de apagar qualquer coisa. Ver A06-03 na auditoria de
  // segurança (docs/auditoria-seguranca-web).
  const doDelete = async () => {
    if (!proof.trim()) {
      showToast(
        byPassword ? 'Digite sua senha para confirmar.' : 'Digite seu e-mail para confirmar.',
      );
      return;
    }
    setDeleting(true);
    const { error } = await deleteAccount(
      byPassword ? { password: proof } : { confirmText: proof },
    );
    setDeleting(false);
    if (error) {
      showToast(error);
      return;
    }
    showToast('Conta excluída.');
    await signOut();
  };

  const cancelDelete = () => {
    setConfirming(false);
    setProof('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.label}>E-mail</Text>
          <Text style={styles.value}>{user?.email ?? '—'}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.label}>Empresa ativa</Text>
          <Text style={styles.value}>
            {currentTenantId ? 'Vinculada ✓' : 'Aguardando 1º sync online'}
          </Text>
        </View>

        <View style={styles.actions}>
          <Button title="Sair da conta" variant="outline" onPress={onLogout} />
          {!confirming && (
            <Button title="Excluir conta" variant="text" onPress={() => setConfirming(true)} />
          )}
        </View>

        {confirming && (
          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Excluir conta e empresa</Text>
            <Text style={styles.dangerText}>
              Esta ação apaga de forma permanente a sua conta e todos os dados da empresa —
              produtos, estoque, vendas, comandas e o acesso de toda a equipe. Não há como desfazer.
            </Text>
            <View style={styles.field}>
              {byPassword ? (
                <TextField
                  label="Confirme sua senha"
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="current-password"
                  textContentType="password"
                  value={proof}
                  onChangeText={setProof}
                  // A tecla do teclado apenas fecha o teclado: apagar a conta é
                  // ação do botão, nunca de um toque na tecla verde.
                  returnKeyType="done"
                  blurOnSubmit
                />
              ) : (
                <TextField
                  label={`Digite seu e-mail (${user?.email ?? ''}) para confirmar`}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="off"
                  value={proof}
                  onChangeText={setProof}
                  returnKeyType="done"
                  blurOnSubmit
                />
              )}
            </View>
            <View style={styles.actions}>
              <Button
                title="Excluir definitivamente"
                variant="text"
                onPress={() => void doDelete()}
                loading={deleting}
              />
              <Button title="Cancelar" variant="outline" onPress={cancelDelete} />
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  label: { color: colors.textSecondary, fontSize: 13 },
  value: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.xs },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
  dangerCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  dangerTitle: { color: colors.danger, fontSize: 16, fontWeight: '700' },
  dangerText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
  },
  field: { marginTop: spacing.md },
});
