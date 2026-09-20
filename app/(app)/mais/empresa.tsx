import { Ionicons } from '@expo/vector-icons';
import { Redirect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/design/tokens';
import { cnpjValidationMessage, formatCnpjInput, unmaskCnpj } from '@/lib/cnpj';
import { logSilently, reportError } from '@/lib/feedback';
import { usePermissions } from '@/lib/permissions';
import { formatPhoneInput, phoneValidationMessage, unmaskPhone } from '@/lib/phone';
import { showToast } from '@/lib/toast';
import { inviteMember } from '@/services/functions';
import {
  deactivateMember,
  fetchMembers,
  fetchTenant,
  reactivateMember,
  updateTenant,
  type TenantMember,
} from '@/services/tenant';
import { setCachedTenantName } from '@/services/tenantBranding';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/Chip';
import { TextField } from '@/ui/TextField';

export default function Empresa() {
  const { canAccessCompany, readOnlyReason } = usePermissions();
  const tenantId = useAuthStore((s) => s.currentTenantId);
  const session = useAuthStore((s) => s.session);
  const userId = useAuthStore((s) => s.user?.id);

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [name, setName] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [cnpjError, setCnpjError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'manager' | 'employee'>('employee');
  const [inviting, setInviting] = useState(false);

  const myRole = members.find((m) => m.userId === userId)?.role;
  const isOwner = myRole === 'owner';

  const loadMembers = () => {
    if (tenantId)
      fetchMembers(tenantId)
        .then(setMembers)
        .catch((e) => logSilently(e, { action: 'Carregar a equipe da empresa' }));
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
      void setCachedTenantName(t.name);
      setMembers(await fetchMembers(tenantId));
    } catch (e) {
      // A tela já mostra o estado de falha; o log guarda a causa.
      logSilently(e, { action: 'Carregar os dados da empresa' });
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Roda ao sair do campo (feedback imediato) e de novo ao salvar (garante que
  // não escapa por um caminho que pule o blur, como colar e tocar direto no botão).
  // Devolve a mensagem (ou null se ok) porque o chamador decide o que fazer com
  // ela: onBlur só deixa no campo, onSave também avisa em toast — sem toast no
  // blur, um clique que erra o campo por engano viraria alerta incômodo.
  const validateCnpj = (): string | null => {
    const cnpjRaw = unmaskCnpj(cnpj);
    const message = cnpjValidationMessage(cnpjRaw);
    setCnpjError(message);
    if (message && cnpjRaw.length === 14) {
      logSilently(new Error('CNPJ com dígito verificador inválido'), {
        action: 'Validar CNPJ da empresa',
        screen: 'empresa',
        meta: { cnpjDigitado: cnpj },
      });
    }
    return message;
  };

  // Mesmo padrão do CNPJ, sem o log em error_logs: aqui não existe "dígito
  // verificador" a falhar — só o tamanho, então não há nada de irregular a
  // registrar, apenas um campo incompleto.
  const validatePhone = (): string | null => {
    const message = phoneValidationMessage(unmaskPhone(phone));
    setPhoneError(message);
    return message;
  };

  const onSave = async () => {
    if (!tenantId) return;
    if (!name.trim()) {
      showToast('Informe o nome da empresa.');
      return;
    }
    const cnpjMessage = validateCnpj();
    if (cnpjMessage) {
      // O campo já mostra o aviso, mas sem isto um toque em "Salvar" sem efeito
      // nenhum passa a impressão de que salvou — o usuário precisa de uma
      // confirmação de que a ação FALHOU, não só de que o campo está com erro.
      showToast(cnpjMessage);
      return;
    }
    const phoneMessage = validatePhone();
    if (phoneMessage) {
      showToast(phoneMessage);
      return;
    }
    setSaving(true);
    const trimmedName = name.trim();
    const { error } = await updateTenant(tenantId, {
      name: trimmedName,
      cnpj: cnpj.trim(),
      phone: phone.trim(),
    });
    setSaving(false);
    if (!error) void setCachedTenantName(trimmedName);
    showToast(error ?? 'Empresa atualizada! ✅');
  };

  // INATIVAR, não excluir: o dono é titular do vínculo, não dos dados pessoais
  // da pessoa. Ele revoga o acesso dela à empresa; excluir a conta é ação que só
  // o próprio usuário faz, em Conta → Excluir conta.
  const onDeactivate = (member: TenantMember) => {
    if (!tenantId) return;
    Alert.alert(
      'Inativar membro',
      'Esta pessoa perde o acesso aos dados da empresa imediatamente. A conta dela não é excluída, e o histórico de vendas e lançamentos continua registrado. Você pode reativar depois.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Inativar',
          style: 'destructive',
          onPress: () => {
            deactivateMember(tenantId, member.userId)
              .then(({ error }) => {
                if (error) showToast(error);
                else {
                  showToast('Membro inativado.');
                  loadMembers();
                }
              })
              .catch((e) => void reportError(e, { action: 'Inativar membro da equipe' }));
          },
        },
      ],
    );
  };

  // Também é o caminho para destravar vendas retidas no aparelho de quem foi
  // inativado: reativar → o app sincroniza → inativar de novo.
  const onReactivate = (member: TenantMember) => {
    if (!tenantId) return;
    reactivateMember(tenantId, member.userId)
      .then(({ error }) => {
        if (error) showToast(error);
        else {
          showToast('Membro reativado.');
          loadMembers();
        }
      })
      .catch((e) => void reportError(e, { action: 'Reativar membro da equipe' }));
  };

  const onInvite = async () => {
    if (!inviteEmail.trim()) {
      showToast('Informe o e-mail.');
      return;
    }
    const email = inviteEmail.trim();
    setInviting(true);
    const { error, invited } = await inviteMember(email, inviteRole);
    setInviting(false);
    if (error) {
      showToast(error);
      return;
    }
    setInviteEmail('');
    loadMembers();
    if (invited) {
      // Convite pendente: a pessoa entra ao se cadastrar no app com este e-mail.
      Alert.alert(
        'Convite registrado',
        `Peça para ${email} baixar o app e se cadastrar usando exatamente este e-mail. ` +
          'Ao concluir o cadastro, ela entra automaticamente na sua equipe.',
      );
    } else {
      showToast('Membro adicionado!');
    }
  };

  // employee não acessa Minha Empresa (guarda de deep-link; a RLS confirma no servidor).
  if (!canAccessCompany) return <Redirect href="/mais" />;

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
        onChangeText={(t) => {
          setCnpj(formatCnpjInput(t));
          if (cnpjError) setCnpjError(null);
        }}
        onBlur={validateCnpj}
        editable={isOwner}
        autoCapitalize="characters"
        maxLength={18}
        error={cnpjError ?? undefined}
      />
      <TextField
        label="Telefone — opcional"
        value={phone}
        onChangeText={(t) => {
          setPhone(formatPhoneInput(t));
          if (phoneError) setPhoneError(null);
        }}
        onBlur={validatePhone}
        editable={isOwner}
        keyboardType="phone-pad"
        maxLength={15}
        error={phoneError ?? undefined}
      />
      {isOwner ? (
        <Button
          title="Salvar dados"
          onPress={onSave}
          loading={saving}
          disabledReason={readOnlyReason ?? undefined}
        />
      ) : (
        <Text style={styles.hint}>Apenas o dono (owner) pode editar os dados da empresa.</Text>
      )}

      <Text style={styles.section}>Equipe ({members.filter((m) => m.active).length})</Text>
      {members
        .filter((m) => m.active)
        .map((member) => (
          <View key={member.userId} style={styles.memberRow}>
            <View style={styles.memberMain}>
              <Text style={styles.memberId}>{member.userId.slice(0, 8)}…</Text>
              <Text style={styles.memberRole}>{member.role}</Text>
            </View>
            {isOwner && member.userId !== userId && (
              <Pressable
                onPress={() => onDeactivate(member)}
                hitSlop={8}
                accessibilityLabel="Inativar membro"
              >
                <Text style={styles.remove}>Inativar</Text>
              </Pressable>
            )}
          </View>
        ))}

      {/* Inativos ficam VISÍVEIS de propósito: sem isso, um clique errado seria
          irreversível pela interface — e é por aqui que o dono reativa alguém
          para destravar vendas presas no aparelho. */}
      {isOwner && members.some((m) => !m.active) && (
        <>
          <Text style={styles.section}>Inativos ({members.filter((m) => !m.active).length})</Text>
          {members
            .filter((m) => !m.active)
            .map((member) => (
              <View key={member.userId} style={styles.memberRow}>
                <View style={styles.memberMain}>
                  <Text style={[styles.memberId, styles.memberInactive]}>
                    {member.userId.slice(0, 8)}…
                  </Text>
                  <Text style={styles.memberRole}>{member.role} · sem acesso</Text>
                </View>
                <Pressable
                  onPress={() => onReactivate(member)}
                  hitSlop={8}
                  accessibilityLabel="Reativar membro"
                >
                  <Text style={styles.reactivate}>Reativar</Text>
                </Pressable>
              </View>
            ))}
        </>
      )}

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
          <Button
            title="Convidar"
            onPress={onInvite}
            loading={inviting}
            disabledReason={readOnlyReason ?? undefined}
          />
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
  reactivate: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  memberInactive: { opacity: 0.6 },
});
