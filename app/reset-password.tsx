import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '@/data/remote/supabaseClient';
import { colors, spacing } from '@/design/tokens';
import { updatePassword } from '@/services/auth';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

type Phase = 'verifying' | 'ready' | 'invalid';

/**
 * Handler do deep link de recuperação de senha: `sirbarbecue://reset-password?code=...`.
 * Top-level (fora dos grupos) de propósito: a sessão de recovery criada aqui NÃO deve
 * acionar o gate de (app)/(auth) antes do usuário definir a nova senha.
 */
export default function ResetPassword() {
  const params = useLocalSearchParams<{ code?: string }>();
  const [phase, setPhase] = useState<Phase>('verifying');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const code = typeof params.code === 'string' ? params.code : undefined;
      if (!code) {
        const { data } = await supabase.auth.getSession();
        if (active) setPhase(data.session ? 'ready' : 'invalid');
        return;
      }
      const { error: e } = await supabase.auth.exchangeCodeForSession(code);
      if (!active) return;
      if (e) {
        const { data } = await supabase.auth.getSession();
        setPhase(data.session ? 'ready' : 'invalid');
      } else {
        setPhase('ready');
      }
    })();
    return () => {
      active = false;
    };
  }, [params.code]);

  const onSubmit = async () => {
    setError(null);
    if (password.length < 6) {
      setError('A senha deve ter ao menos 6 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('As senhas não coincidem.');
      return;
    }
    setLoading(true);
    const { error: e } = await updatePassword(password);
    setLoading(false);
    if (e) {
      setError(e);
      return;
    }
    router.replace('/(app)');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Nova senha</Text>

          {phase === 'verifying' && <ActivityIndicator color={colors.gold} style={styles.spinner} />}

          {phase === 'invalid' && (
            <>
              <Text style={styles.subtitle}>
                Link inválido ou expirado. Solicite um novo a partir do login.
              </Text>
              <Button
                title="Voltar ao login"
                variant="outline"
                onPress={() => router.replace('/(auth)/login')}
              />
            </>
          )}

          {phase === 'ready' && (
            <>
              <Text style={styles.subtitle}>Defina sua nova senha de acesso.</Text>
              <TextField
                label="Nova senha"
                value={password}
                onChangeText={setPassword}
                placeholder="mínimo 6 caracteres"
                secureTextEntry
                autoCapitalize="none"
                textContentType="newPassword"
              />
              <TextField
                label="Confirmar senha"
                value={confirm}
                onChangeText={setConfirm}
                placeholder="repita a senha"
                secureTextEntry
                autoCapitalize="none"
                textContentType="newPassword"
              />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Button title="Salvar nova senha" onPress={onSubmit} loading={loading} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700', marginBottom: spacing.sm },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginBottom: spacing.lg, lineHeight: 22 },
  spinner: { marginTop: spacing.lg },
  error: { color: colors.danger, fontSize: 14, marginBottom: spacing.sm },
});
