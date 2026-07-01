import { Link } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/design/tokens';
import { resetPassword } from '@/services/auth';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSend = async () => {
    setError(null);
    setLoading(true);
    const { error: e } = await resetPassword(email);
    setLoading(false);
    if (e) setError(e);
    else setSent(true);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Recuperar senha</Text>

          {sent ? (
            <>
              <Text style={styles.subtitle}>
                Se existir uma conta para <Text style={styles.email}>{email.trim()}</Text>, enviamos
                um link para redefinir a senha. Verifique seu e-mail.
              </Text>
              <Link href="/(auth)/login" style={styles.link}>
                Voltar ao login
              </Link>
            </>
          ) : (
            <>
              <Text style={styles.subtitle}>
                Informe seu e-mail e enviaremos um link para criar uma nova senha.
              </Text>
              <TextField
                label="E-mail"
                value={email}
                onChangeText={setEmail}
                placeholder="voce@email.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
              />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <Button title="Enviar link" onPress={onSend} loading={loading} />
              <Link href="/(auth)/login" style={styles.link}>
                Voltar ao login
              </Link>
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
  email: { color: colors.textPrimary, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14, marginBottom: spacing.sm },
  link: {
    color: colors.gold,
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
