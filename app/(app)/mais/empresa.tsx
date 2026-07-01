import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { showToast } from '@/lib/toast';
import { inviteMember } from '@/services/functions';
import {
  fetchMembers,
  fetchTenant,
  removeMember,
  updateTenant,
  type TenantMember,
} from '@/services/tenant';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { TextField } from '@/ui/TextField';

export default function Empresa() {
  const tenantId = useAuthStore((s) => s.currentTenantId);
  const session = useAuthStore((s) => s.session);
  const userId = useAuthStore((s) => s.user?.id);

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [phone, setPhone] = useState('');
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager' | 'employee'>('employee');
  const [inviting, setInviting] = useState(false);

  const myRole = members.find((m) => m.userId === userId)?.role;
  const isOwner = myRole === 'owner';

  const loadMembers = () => {
    if (tenantId) fetchMembers(tenantId).then(setMembers).catch(() => undefined);
  };

  const load = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadFailed(false);
    try {
      const t = await fetchTenant(tenantId);
      if (!t) {
        setLoadFailed(true);
        return;
      }
      setName(t.name);
      setCnpj(t.cnpj ?? '');
      setPhone(t.phone ?? '');
      setMembers(await fetchMembers(tenantId));
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async () => {
    if (!tenantId) return;
    if (!name.trim()) {
      showToast('Informe o nome da empresa.');
      return;
    }
    setSaving(true);
    const { error } = await updateTenant(tenantId, {
      name: name.trim(),
      cnpj: cnpj.trim(),
      phone: phone.trim(),
    });
    setSaving(false);
    showToast(error ?? 'Empresa atualizada! ✅');
  };

  const onRemove = (member: TenantMember) => {
    if (!tenantId) return;
    Alert.alert('Remover membro', 'Remover este membro da empresa?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Remover',
        style: 'destructive',
        onPress: () => {
          removeMember(tenantId, member.userId)
            .then(({ error }) => {
              if (error) showToast(error);
              else {
                showToast('Membro removido.');
                loadMembers();
              }
            })
            .catch(() => undefined);
        },
      },
    ]);
  };

  const onInvite = async () => {
    if (!inviteEmail.trim()) {
      showToast('Informe o e-mail.');
      return;
    }
    setInviting(true);
    const { error, invited } = await inviteMember(inviteEmail.trim(), inviteRole);
    setInviting(false);
    if (error) {
      showToast(error);
      return;
    }
    showToast(invited ? 'Convite enviado por e-mail!' : 'Membro adicionado!');
    setInviteEmail('');
    loadMembers();
  };

  // Sem empresa ativa: distingue "sem login real" de "logado, mas conta sem empresa".
  if (!tenantId) {
    return (
      <View style={styles.center}>
        <Ionicons name="business-outline" size={48} color={colors.textSecondary} />
        {session ? (
          <>
            <Text style={styles.emptyTitle}>Nenhuma empresa vinculada</Text>
            <Text style={styles.emptyText}>
              Sua conta não está ligada a nenhuma empresa. Normalmente a empresa é criada no cadastro
              — se você criou a conta antes desta versão, crie uma conta nova para gerar a sua
              empresa, ou peça para um administrador te adicionar à equipe dele.
            </Text>
          </>
        ) : (
          <Text style={styles.emptyText}>
            Você está sem login real (modo de desenvolvimento). Entre com uma conta para visualizar e
            gerenciar a empresa.
          </Text>
        )}
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.gold} />
      </View>
    );
  }

  // Tem empresa, mas a leitura falhou (offline / erro de rede).
  if (loadFailed) {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={48} color={colors.textSecondary} />
        <Text style={styles.emptyTitle}>Não foi possível carregar</Text>
        <Text style={styles.emptyText}>
          Os dados da empresa ficam no servidor. Verifique sua conexão e tente novamente.
        </Text>
        <Button title="Tentar novamente" variant="outline" onPress={() => void load()} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.section}>Dados da empresa</Text>
      <TextField label="Nome" value={name} onChangeText={setName} editable={isOwner} autoCapitalize="words" />
      <TextField
        label="CNPJ — opcional"
        value={cnpj}
        onChangeText={setCnpj}
        editable={isOwner}
        keyboardType="number-pad"
      />
      <TextField
        label="Telefone — opcional"
        value={phone}
        onChangeText={setPhone}
        editable={isOwner}
        keyboardType="phone-pad"
      />
      {isOwner ? (
        <Button title="Salvar dados" onPress={onSave} loading={saving} />
      ) : (
        <Text style={styles.hint}>Apenas o dono (owner) pode editar os dados da empresa.</Text>
      )}

      <Text style={styles.section}>Equipe ({members.length})</Text>
      {members.map((member) => (
        <View key={member.userId} style={styles.memberRow}>
          <View style={styles.memberMain}>
            <Text style={styles.memberId}>{member.userId.slice(0, 8)}…</Text>
            <Text style={styles.memberRole}>{member.role}</Text>
          </View>
          {isOwner && member.userId !== userId && (
            <Pressable onPress={() => onRemove(member)} hitSlop={8} accessibilityLabel="Remover membro">
              <Text style={styles.remove}>Remover</Text>
            </Pressable>
          )}
        </View>
      ))}

      {isOwner && (
        <>
          <Text style={styles.section}>Convidar membro</Text>
          <TextField
            label="E-mail"
            value={inviteEmail}
            onChangeText={setInviteEmail}
            placeholder="pessoa@email.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <View style={styles.chips}>
            <Chip
              label="Funcionário"
              selected={inviteRole === 'employee'}
              onPress={() => setInviteRole('employee')}
            />
            <Chip
              label="Gerente"
              selected={inviteRole === 'manager'}
              onPress={() => setInviteRole('manager')}
            />
          </View>
          <Button title="Convidar" onPress={onInvite} loading={inviting} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  emptyTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyText: { color: colors.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 22 },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.md },
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.sm },
  chips: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.sm },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  memberMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  memberId: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  memberRole: { color: colors.gold, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' },
  remove: { color: colors.danger, fontSize: 13, fontWeight: '600' },
});
