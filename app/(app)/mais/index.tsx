import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';

type Item = { icon: keyof typeof Ionicons.glyphMap; label: string; route: Href; hint?: string };

const ITEMS: Item[] = [
  { icon: 'business-outline', label: 'Minha Empresa', route: '/mais/empresa', hint: 'Dados e equipe' },
  { icon: 'people-outline', label: 'Fornecedores', route: '/mais/fornecedores', hint: 'Cadastro e preços de compra' },
  { icon: 'bar-chart-outline', label: 'Relatórios', route: '/mais/relatorios', hint: 'Vendas e produtos' },
  { icon: 'notifications-outline', label: 'Notificações', route: '/mais/notificacoes' },
  { icon: 'person-outline', label: 'Conta', route: '/mais/perfil', hint: 'Perfil e sair' },
];

export default function MaisHub() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {ITEMS.map((item) => (
        <Pressable
          key={item.label}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => router.push(item.route)}
          accessibilityRole="button"
          accessibilityLabel={item.label}
        >
          <Ionicons name={item.icon} size={22} color={colors.gold} />
          <View style={styles.rowText}>
            <Text style={styles.label}>{item.label}</Text>
            {!!item.hint && <Text style={styles.hint}>{item.hint}</Text>}
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  pressed: { opacity: 0.85 },
  rowText: { flex: 1 },
  label: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
});
