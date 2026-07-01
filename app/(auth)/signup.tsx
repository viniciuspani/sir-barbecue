import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/design/tokens';
import { signUpWithEmail } from '@/services/auth';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

export default function SignUp() {
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignUp = async () => {
    setError(null);
    if (!businessName.trim()) {
      setError('Informe o nome da empresa.');
      return;
    }
    if (password.length < 6) {
      setError('A senha deve ter ao menos 6 caracteres.');
      return;
    }
    if (password !== confirm) {
      setError('As senhas não coincidem.');
      return;
    }
    setLoading(true);
    const { error: e, needsConfirmation } = await signUpWithEmail(email, password, businessName);
    setLoading(false);
    if (e) {
      setError(e);
      return;
    }
    // Com confirmação de e-mail ligada (RF-01), vai para a tela de verificação.
    // Sem confirmação, a sessão já ativa e o gate redireciona sozinho.
    if (needsConfirmation) {
      router.replace({ pathname: '/(auth)/verify-email', params: { email: email.trim() } });
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Criar conta</Text>
          <Text style={styles.subtitle}>Crie a conta da sua empresa para começar.</Text>

          <TextField
            label="Nome da empresa"
            value={businessName}
            onChangeText={setBusinessName}
            placeholder="ex.: Churrasquinho do Zé"
            autoCapitalize="words"
          />
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
          <TextField
            label="Senha"
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

          <Button title="Criar conta" onPress={onSignUp} loading={loading} />

          <View style={styles.footer}>
            <Text style={styles.footerText}>Já tem conta? </Text>
            <Link href="/(auth)/login" style={styles.footerLink}>
              Entrar
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '700', marginBottom: spacing.xs },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginBottom: spacing.lg },
  error: { color: colors.danger, fontSize: 14, marginBottom: spacing.sm },
  footer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: spacing.lg },
  footerText: { color: colors.textSecondary, fontSize: 15 },
  footerLink: { color: colors.gold, fontSize: 15, fontWeight: '600' },
});
