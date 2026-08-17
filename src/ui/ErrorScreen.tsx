import { Ionicons } from '@expo/vector-icons';
import type { ErrorBoundaryProps } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { logError } from '@/services/errorLog';
import { Button } from '@/ui/Button';

/**
 * Tela mostrada quando um erro quebra o render — no lugar da tela branca.
 * Registra a falha como 'fatal' e mostra o código de referência para o suporte.
 */
export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const [refCode, setRefCode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void logError(error, { action: 'Exibir a tela', severity: 'fatal' }).then((code) => {
      if (active) setRefCode(code);
    });
    return () => {
      active = false;
    };
  }, [error]);

  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.gold} />
      </View>

      <Text style={styles.title}>Algo não saiu como esperado</Text>
      <Text style={styles.body}>
        Tivemos um problema ao abrir esta tela. Já registramos o ocorrido e você pode tentar de novo.
      </Text>
      {refCode ? <Text style={styles.code}>Código: {refCode}</Text> : null}

      <Button title="Tentar novamente" onPress={() => void retry()} style={styles.button} />
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
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  body: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  code: {
    color: colors.gold,
    fontSize: 14,
    fontWeight: '700',
    marginTop: spacing.lg,
    letterSpacing: 1,
  },
  button: { marginTop: spacing.xl, alignSelf: 'stretch' },
});
