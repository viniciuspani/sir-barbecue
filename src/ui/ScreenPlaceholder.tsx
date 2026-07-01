import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/design/tokens';

type Props = { title: string; subtitle?: string };

// Placeholder reutilizável do shell (Fase 1). As telas reais entram nas fases seguintes.
export function ScreenPlaceholder({ title, subtitle }: Props) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>
          {subtitle ?? 'Tela em construção — shell de navegação (Fase 1).'}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  title: { color: colors.gold, fontSize: 24, fontWeight: '700', marginBottom: spacing.sm },
  subtitle: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 22 },
});
