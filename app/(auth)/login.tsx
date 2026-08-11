import { Link, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/design/tokens';
import { signInWithEmail, signInWithGoogle } from '@/services/auth';
import { getCachedTenantName } from '@/services/tenantBranding';
import { useAuthStore } from '@/store/authStore';
import { BrandLogo } from '@/ui/BrandLogo';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

// Placeholder exibido enquanto nenhuma empresa com nome próprio foi cadastrada
// neste aparelho ainda (nem no primeiro cadastro, nem em "Minha Empresa").
const TAGLINE_PLACEHOLDER = 'Nome do Espetinho';

export default function Login() {
  const signInDev = useAuthStore((s) => s.signInDev);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagline, setTagline] = useState(TAGLINE_PLACEHOLDER);
  const scrollRef = useRef<ScrollView>(null);
  const scrollToEnd = () => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);

  // Nome da empresa cadastrada neste aparelho (se houver) — a tela de login roda
  // ANTES do login, então só há esse nome via cache local (ver services/tenantBranding).
  useEffect(() => {
    let active = true;
    getCachedTenantName().then((name) => {
      if (active && name) setTagline(name);
    });
    return () => {
      active = false;
    };
  }, []);

  // Sucesso de login dispara onAuthStateChange → o gate em (auth)/_layout redireciona p/ (app).
  const onLogin = async () => {
    setError(null);
    setLoading(true);
    const { error: e } = await signInWithEmail(email, password);
    setLoading(false);
    if (e) setError(e);
  };

  const onGoogle = async () => {
    setError(null);
    setLoading(true);
    const { error: e, cancelled } = await signInWithGoogle();
    setLoading(false);
    if (e && !cancelled) setError(e);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandBox}>
            <BrandLogo size={96} style={styles.logo} />
            <Text style={styles.brand}>Sir Barbecue</Text>
            <Text style={styles.tagline}>{tagline}</Text>
          </View>

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
            placeholder="••••••••"
            secureTextEntry
            autoCapitalize="none"
            textContentType="password"
            onFocus={scrollToEnd}
          />

          {!!error && <Text style={styles.error}>{error}</Text>}

          <Button title="Entrar" onPress={onLogin} loading={loading} />
          <Link href="/(auth)/forgot-password" style={styles.link}>
            Esqueci minha senha
          </Link>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>ou</Text>
            <View style={styles.dividerLine} />
          </View>

          <Button title="Entrar com Google" variant="outline" onPress={onGoogle} loading={loading} />

          <View style={styles.footer}>
            <Text style={styles.footerText}>Não tem conta? </Text>
            <Link href="/(auth)/signup" style={styles.footerLink}>
              Criar conta
            </Link>
          </View>

          {__DEV__ && (
            <Button
              title="Entrar sem login (dev)"
              variant="text"
              onPress={() => {
                signInDev();
                router.replace('/(app)');
              }}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.sm,
  },
  brandBox: { alignItems: 'center', marginBottom: spacing.xl },
  logo: { alignSelf: 'center', marginBottom: spacing.md },
  brand: { color: colors.gold, fontSize: 32, fontWeight: '700' },
  tagline: { color: colors.textSecondary, fontSize: 16, marginTop: spacing.sm },
  error: { color: colors.danger, fontSize: 14, marginBottom: spacing.sm },
  link: { color: colors.gold, fontSize: 15, fontWeight: '500', textAlign: 'center', paddingVertical: spacing.md },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.divider },
  dividerText: { color: colors.textSecondary, fontSize: 14, marginHorizontal: spacing.md },
  footer: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: spacing.lg },
  footerText: { color: colors.textSecondary, fontSize: 15 },
  footerLink: { color: colors.gold, fontSize: 15, fontWeight: '600' },
});
