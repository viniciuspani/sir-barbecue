import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { refreshPendingCount } from '@/data/sync/syncEngine';
import { colors, fontSizes, radii, spacing } from '@/design/tokens';
import { formatIsoDate } from '@/lib/dates';
import { showToast } from '@/lib/toast';
import { usesPasswordLogin } from '@/services/auth';
import { requestAccountDeletion } from '@/services/functions';
import { fetchMembershipDetail, type MembershipDetail } from '@/services/tenant';
import { useAuthStore } from '@/store/authStore';
import { useSyncStore } from '@/store/syncStore';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

/**
 * Tela de bloqueio para usuário AUTENTICADO mas SEM vínculo com nenhuma empresa.
 *
 * TRÊS caminhos chegam aqui, e antes da MIGRATION_26 o app não os distinguia —
 * todos viravam o mesmo `membershipStatus === 'none'`:
 *  • nunca foi adicionado;
 *  • foi INATIVADO pelo dono (`tenant_members.removed_at`, MIGRATION_21);
 *  • a EMPRESA foi excluída — e aqui o cascade apaga a linha inteira, sem deixar
 *    nem `removed_at`. Era o caso mais grave: a tela mandava "peça ao
 *    administrador que envie um convite", sendo que o administrador não existe
 *    mais e o convite nunca enviou e-mail (invite-member/index.ts:149-153).
 * `my_membership_status()` separa os três.
 *
 * E o mais importante: esta tela roda ANTES de qualquer rota do app
 * (app/(app)/_layout.tsx), e o layout de (auth) devolve quem está autenticado
 * para cá. Quem cai aqui não alcança a tela de Conta — então as ações que
 * dependem de ser o titular dos próprios dados (excluir a conta) precisam
 * existir NESTA tela, ou não existem em lugar nenhum.
 */

type Copy = { icon: keyof typeof Ionicons.glyphMap; title: string; body: string };

function copyFor(detail: MembershipDetail | null): Copy {
  switch (detail?.reason) {
    case 'tenant_deleted':
      return {
        icon: 'business-outline',
        title: 'Empresa encerrada',
        body:
          'A empresa em que você usava o Sir Barbecue encerrou a conta, então seu acesso a ela terminou. ' +
          'Sua conta continua sendo sua: se alguém te adicionar a outra empresa, é só entrar de novo.',
      };
    case 'removed':
      return {
        icon: 'person-remove-outline',
        title: 'Acesso removido',
        body:
          'O responsável pela empresa removeu o seu acesso. Fale com ele para voltar a usar o app — ' +
          'sua conta continua ativa.',
      };
    default:
      return {
        icon: 'business-outline',
        title: 'Conta sem empresa',
        body:
          'Sua conta ainda não está vinculada a nenhuma empresa. Quem administra a empresa precisa ' +
          'te adicionar pelo app — não enviamos e-mail de convite, então avise a pessoa de que você ' +
          'já se cadastrou com este e-mail.',
      };
  }
}

export function MembershipRequired() {
  const signOut = useAuthStore((s) => s.signOut);
  const user = useAuthStore((s) => s.user);
  const pending = useSyncStore((s) => s.pending);
  const contact = process.env.EXPO_PUBLIC_SUPPORT_CONTACT;

  const [detail, setDetail] = useState<MembershipDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [proof, setProof] = useState('');
  const [deleting, setDeleting] = useState(false);

  const byPassword = usesPasswordLogin(user);
  const email = detail?.email ?? user?.email ?? '';

  useEffect(() => {
    void refreshPendingCount();
    void fetchMembershipDetail().then(setDetail);
  }, []);

  const copy = copyFor(detail);

  const openContact = () => {
    if (!contact) return;
    const url = contact.includes('@')
      ? `mailto:${contact}`
      : `https://wa.me/${contact.replace(/\D/g, '')}`;
    void Linking.openURL(url);
  };

  /**
   * Exclusão IMEDIATA. Quem está aqui não é dono de empresa nenhuma, então cai no
   * caminho 2 da Edge Function: nada de agendamento, de exportação ou de contato
   * de retenção — não há empresa para exportar nem para negociar.
   */
  const doDelete = async () => {
    setDeleting(true);
    const { error } = await requestAccountDeletion({
      ...(byPassword ? { password: proof } : { confirmText: proof }),
      exportRequested: false,
      localPending: 0,
    });
    setDeleting(false);
    if (error) {
      showToast(error);
      return;
    }
    showToast('Conta excluída.');
    await signOut();
  };

  const onDeletePress = () => {
    if (!proof.trim()) {
      showToast(byPassword ? 'Digite sua senha para confirmar.' : 'Digite seu e-mail para confirmar.');
      return;
    }
    Alert.alert(
      'Excluir sua conta?',
      'Sua conta e o seu cadastro são apagados agora, de forma definitiva. Não há como desfazer.',
      [
        { text: 'Voltar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: () => void doDelete() },
      ],
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.iconWrap}>
        <Ionicons name={copy.icon} size={48} color={colors.gold} />
      </View>

      <Text style={styles.brand}>Sir Barbecue</Text>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>

      {/* O e-mail é o único dado pessoal dele que resta no sistema depois de a
          empresa sumir. Mostrá-lo aqui atende ao direito de acesso sem precisar
          de exportação nenhuma — e ele nem alcançaria a tela de Conta. */}
      {email ? (
        <View style={styles.emailBox}>
          <Text style={styles.emailLabel}>Sua conta</Text>
          <Text style={styles.emailValue}>{email}</Text>
        </View>
      ) : null}

      {detail?.reason === 'tenant_deleted' && detail.purgeAfter ? (
        <Text style={styles.note}>
          Contas sem empresa vinculada são encerradas a partir de{' '}
          {formatIsoDate(detail.purgeAfter)}. Avisamos por e-mail antes disso.
        </Text>
      ) : null}

      {pending > 0 && (
        <View style={styles.pendingBox}>
          <Text style={styles.pendingTitle}>
            {pending === 1 ? '1 registro não enviado' : `${pending} registros não enviados`}
          </Text>
          <Text style={styles.pendingBody}>
            {detail?.reason === 'tenant_deleted'
              ? 'Há trabalho salvo neste aparelho que nunca chegou a subir. Como a empresa foi encerrada, não há mais para onde enviar.'
              : 'Há trabalho salvo neste aparelho que ainda não subiu para a empresa. Nada foi perdido — peça ao responsável para reativar seu acesso e abra o app uma vez para sincronizar.'}
          </Text>
        </View>
      )}

      {confirming ? (
        <View style={styles.dangerCard}>
          <Text style={styles.dangerTitle}>Excluir minha conta</Text>
          <Text style={styles.dangerText}>
            Apaga a sua conta e o seu cadastro de forma definitiva, agora. Não há como desfazer.
          </Text>
          <View style={styles.field}>
            {byPassword ? (
              <TextField
                label="Confirme sua senha"
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
                textContentType="password"
                value={proof}
                onChangeText={setProof}
                returnKeyType="done"
                blurOnSubmit
              />
            ) : (
              <TextField
                label={`Digite seu e-mail (${email}) para confirmar`}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="off"
                value={proof}
                onChangeText={setProof}
                returnKeyType="done"
                blurOnSubmit
              />
            )}
          </View>
          <Button
            title="Excluir minha conta"
            variant="danger"
            onPress={onDeletePress}
            loading={deleting}
            style={styles.button}
          />
          <Button
            title="Voltar"
            variant="outline"
            onPress={() => {
              setConfirming(false);
              setProof('');
            }}
            style={styles.buttonSecondary}
          />
        </View>
      ) : (
        <>
          {contact ? (
            <Button
              title="Falar com o suporte"
              variant="outline"
              onPress={openContact}
              style={styles.button}
            />
          ) : null}
          <Button
            title="Excluir minha conta"
            variant="text"
            onPress={() => setConfirming(true)}
            style={styles.buttonSecondary}
          />
          <Button
            title="Sair"
            variant="outline"
            onPress={() => void signOut()}
            style={styles.buttonSecondary}
          />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
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
  brand: { color: colors.gold, fontSize: 28, fontWeight: '700', marginBottom: spacing.sm },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  body: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, textAlign: 'center' },
  emailBox: {
    marginTop: spacing.lg,
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  emailLabel: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
  emailValue: {
    color: colors.textPrimary,
    fontSize: fontSizes.body,
    fontWeight: '600',
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  note: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  pendingBox: {
    marginTop: spacing.lg,
    alignSelf: 'stretch',
    padding: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  pendingTitle: {
    color: colors.gold,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  pendingBody: { color: colors.textSecondary, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  dangerCard: {
    marginTop: spacing.xl,
    alignSelf: 'stretch',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  dangerTitle: { color: colors.danger, fontSize: fontSizes.body, fontWeight: '700' },
  dangerText: {
    color: colors.textSecondary,
    fontSize: fontSizes.body,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  field: { marginTop: spacing.md },
  button: { marginTop: spacing.lg, alignSelf: 'stretch' },
  buttonSecondary: { marginTop: spacing.sm, alignSelf: 'stretch' },
});
