import { Link, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/design/tokens';
import { resendConfirmation } from '@/services/auth';
import { Button } from '@/ui/Button';

export default function VerifyEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const [loading, setLoading] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onResend = async () => {
    if (!email) return;
    setError(null);
    setLoading(true);
    const { error: e } = await resendConfirmation(email);
    setLoading(false);
    if (e) setError(e);
    else setResent(true);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text style={styles.icon}>📧</Text>
        <Text style={styles.title}>Verifique seu e-mail</Text>
        <Text style={styles.subtitle}>
          Enviamos um link de confirmação{email ? ' para ' : ''}
          {email ? <Text style={styles.email}>{email}</Text> : ''}. Confirme para liberar o acesso
          (RF-01) e depois faça login.
        </Text>

        {resent && <Text style={styles.success}>E-mail reenviado ✓</Text>}
        {!!error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.actions}>
          <Button title="Reenviar e-mail" variant="outline" onPress={onResend} loading={loading} />
          <Link href="/(auth)/login" style={styles.link}>
            Voltar ao login
          </Link>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  icon: { fontSize: 56, marginBottom: spacing.lg },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '700', marginBottom: spacing.md },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  email: { color: colors.gold, fontWeight: '600' },
  success: { color: colors.green, fontSize: 14, marginBottom: spacing.sm },
  error: { color: colors.danger, fontSize: 14, marginBottom: spacing.sm },
  actions: { alignSelf: 'stretch', gap: spacing.sm },
  link: {
    color: colors.gold,
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
