import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '@/design/tokens';
import { showToast } from '@/lib/toast';
import { DEFAULT_TENANT_NAME, fetchTenant, updateTenant } from '@/services/tenant';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

/**
 * Passo de boas-vindas enxuto do primeiro login: pede só o nome do negócio.
 * Reaproveita updateTenant (a empresa já existe como "Minha Empresa"). É pulável.
 */
export default function BoasVindas() {
  const router = useRouter();
  const tenantId = useAuthStore((s) => s.currentTenantId);
  const [name, setName] = useState('');
  const [cnpj, setCnpj] = useState<string | undefined>();
  const [phone, setPhone] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  // Carrega a empresa para preservar CNPJ/telefone e evitar sobrescrever no update.
  useEffect(() => {
    if (!tenantId) return;
    fetchTenant(tenantId)
      .then((t) => {
        if (!t) return;
        setCnpj(t.cnpj);
        setPhone(t.phone);
        if (t.name && t.name !== DEFAULT_TENANT_NAME) setName(t.name);
      })
      .catch(() => undefined);
  }, [tenantId]);

  const finish = () => router.back();

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !tenantId) {
      finish();
      return;
    }
    setSaving(true);
    const { error } = await updateTenant(tenantId, { name: trimmed, cnpj, phone });
    setSaving(false);
    if (error) {
      showToast(error);
      return;
    }
    showToast('Tudo pronto! Bem-vindo(a). 🔥');
    finish();
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.emoji}>🔥</Text>
        <Text style={styles.title}>Bem-vindo ao Sir Barbecue</Text>
        <Text style={styles.subtitle}>Como se chama o seu negócio?</Text>

        <TextField
          label="Nome do estabelecimento"
          value={name}
          onChangeText={setName}
          placeholder="Ex.: Churrasquinho do Zé"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={save}
        />

        <Button title="Começar" onPress={save} loading={saving} />
        <Button title="Depois" variant="text" onPress={finish} style={styles.later} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  emoji: { fontSize: 44, textAlign: 'center', marginBottom: spacing.md },
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 16,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  later: { marginTop: spacing.sm },
});
