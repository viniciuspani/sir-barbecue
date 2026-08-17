import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { usePermissions } from '@/lib/permissions';
import { useAuthStore } from '@/store/authStore';

// `requires` (opcional): esconde o item quando o papel não tem a permissão. Sem
// `requires` = visível a todos os membros.
type Perm = 'company' | 'reports' | 'suppliers';
type Item = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  route: Href;
  hint?: string;
  requires?: Perm;
};

const ITEMS: Item[] = [
  { icon: 'business-outline', label: 'Minha Empresa', route: '/mais/empresa', hint: 'Dados e equipe', requires: 'company' },
  { icon: 'people-outline', label: 'Fornecedores', route: '/mais/fornecedores', hint: 'Cadastro e preços de compra', requires: 'suppliers' },
  { icon: 'bar-chart-outline', label: 'Relatórios', route: '/mais/relatorios', hint: 'Vendas e produtos', requires: 'reports' },
  { icon: 'notifications-outline', label: 'Notificações', route: '/mais/notificacoes' },
  { icon: 'help-circle-outline', label: 'Ajuda', route: '/mais/ajuda', hint: 'Como usar o aplicativo' },
  { icon: 'person-outline', label: 'Conta', route: '/mais/perfil', hint: 'Perfil e sair' },
];

export default function MaisHub() {
  const signOut = useAuthStore((s) => s.signOut);
  const { canAccessCompany, canAccessReports, canAccessSuppliers } = usePermissions();
  const items = ITEMS.filter((item) => {
    if (item.requires === 'company') return canAccessCompany;
    if (item.requires === 'reports') return canAccessReports;
    if (item.requires === 'suppliers') return canAccessSuppliers;
    return true;
  });

  // Ação destrutiva de sessão: confirma antes de sair (o gate redireciona ao login).
  const onLogout = () => {
    Alert.alert('Sair', 'Deseja sair da sua conta?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        onPress: () => {
          void signOut();
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {items.map((item) => (
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

      {/* Ação (não navegação): separada dos itens acima, em cor destrutiva e sem chevron. */}
      <Pressable
        style={({ pressed }) => [styles.row, styles.logout, pressed && styles.pressed]}
        onPress={onLogout}
        accessibilityRole="button"
        accessibilityLabel="Sair"
      >
        <Ionicons name="log-out-outline" size={22} color={colors.danger} />
        <View style={styles.rowText}>
          <Text style={[styles.label, styles.logoutLabel]}>Sair</Text>
          <Text style={styles.hint}>Encerrar sessão neste dispositivo</Text>
        </View>
      </Pressable>
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
  logout: { marginTop: spacing.lg, borderWidth: 1, borderColor: colors.danger },
  logoutLabel: { color: colors.danger },
});
