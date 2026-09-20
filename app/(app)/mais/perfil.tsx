import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, fontSizes, radii, spacing } from '@/design/tokens';
import { countPending, runSync } from '@/data/sync/syncEngine';
import { formatIsoDate, formatIsoDateLong, formatIsoDateTime } from '@/lib/dates';
import { logSilently } from '@/lib/feedback';
import { formatPhoneInput, phoneValidationMessage, unmaskPhone } from '@/lib/phone';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import { usesPasswordLogin } from '@/services/auth';
import { getDeletionPreview, requestAccountDeletion } from '@/services/functions';
import { fetchTenant } from '@/services/tenant';
import { useAccessStore } from '@/store/accessStore';
import { useAuthStore } from '@/store/authStore';
import { useConnectivityStore } from '@/store/connectivityStore';
import { Button } from '@/ui/Button';
import { OptionRow } from '@/ui/OptionRow';
import { TextField } from '@/ui/TextField';

export default function Perfil() {
  const user = useAuthStore((s) => s.user);
  const currentTenantId = useAuthStore((s) => s.currentTenantId);
  const signOut = useAuthStore((s) => s.signOut);
  const deletion = useAccessStore((s) => s.deletion);
  const cancelDeletion = useAccessStore((s) => s.cancelDeletion);
  const checkAccess = useAccessStore((s) => s.check);
  const isOnline = useConnectivityStore((s) => s.isOnline);

  // A exclusão tem dois passos: abrir o painel e confirmar.
  const [confirming, setConfirming] = useState(false);
  const [proof, setProof] = useState('');
  const [exportRequested, setExportRequested] = useState(true);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactPhoneError, setContactPhoneError] = useState<string | null>(null);
  const [dates, setDates] = useState<{ noExport: string | null; withExport: string | null }>({
    noExport: null,
    withExport: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);

  // Dono vê o fluxo agendado (prazo, cópia dos dados, contato de retenção);
  // gerente e funcionário são excluídos na hora pelo servidor, e a tela tem de
  // refletir isso. Ver o caminho 2 da delete-account.
  const { role } = usePermissions();
  const isOwner = role === 'owner';

  // Conta do Google não tem senha no Supabase Auth: a confirmação dela é
  // digitar o próprio e-mail. Ver usesPasswordLogin.
  const byPassword = usesPasswordLogin(user);
  const email = user?.email ?? '';

  // As DUAS datas vêm do servidor: o relógio do aparelho é manipulável e o
  // cálculo de dias úteis (com feriados) não pode divergir entre app, PWA e
  // painel. Carregadas ao abrir o painel, junto com o telefone da empresa.
  const openPanel = useCallback(() => {
    setConfirming(true);
    // Não-dono não vê prazo nem contato: a exclusão dele é imediata. Buscar
    // datas e telefone da empresa seria trabalho para uma tela que não existe.
    if (!isOwner) return;
    void (async () => {
      const preview = await getDeletionPreview();
      setDates({ noExport: preview.dateNoExport, withExport: preview.dateWithExport });
      if (preview.error) showToast(preview.error);
      if (currentTenantId) {
        const tenant = await fetchTenant(currentTenantId).catch((e) => {
          logSilently(e, { action: 'Carregar o telefone da empresa', screen: 'perfil' });
          return null;
        });
        if (tenant?.phone) setContactPhone((current) => current || formatPhoneInput(tenant.phone ?? ''));
      }
    })();
  }, [currentTenantId, isOwner]);

  // Se a solicitação for cancelada em outro aparelho, o painel aberto aqui
  // continuaria prometendo uma data que não existe mais.
  useEffect(() => {
    if (deletion) setConfirming(false);
  }, [deletion]);

  const onLogout = () => {
    Alert.alert('Sair', 'Deseja sair da sua conta?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        onPress: () => {
          void signOut(); // o gate redireciona para o login ao limpar a sessão
        },
      },
    ]);
  };

  const scheduledDate = exportRequested ? dates.withExport : dates.noExport;
  const scheduledLabel = exportRequested
    ? formatIsoDate(dates.withExport)
    : formatIsoDateTime(dates.noExport);

  /**
   * RNF-08 — desde a MIGRATION_24 isto SOLICITA a exclusão, não executa.
   *
   * A prova (senha/e-mail) continua sendo revalidada no servidor antes de gravar
   * qualquer coisa: uma solicitação forjada joga a empresa em somente-leitura na
   * hora, ou seja, derruba a operação do balcão mesmo sem apagar nada.
   * Ver A06-03 na auditoria (docs/auditoria-seguranca-web).
   */
  const submit = async () => {
    setSubmitting(true);
    try {
      // O push é do APP: a Edge Function roda no servidor e não alcança o SQLite
      // deste aparelho. Uma venda registrada offline que ainda não subiu seria
      // destruída junto com a empresa, sem nunca ter existido no servidor.
      await runSync();
      const pending = await countPending().catch(() => 0);
      if (pending > 0) {
        showToast('Há vendas ainda não enviadas. Conecte-se à internet e tente de novo.');
        return;
      }

      const { data, error } = await requestAccountDeletion({
        ...(byPassword ? { password: proof } : { confirmText: proof }),
        exportRequested,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        localPending: pending,
      });
      if (error) {
        showToast(error);
        return;
      }

      // Funcionário/gerente continua sendo excluído na hora: exportação, janela
      // de arrependimento e contato de retenção só valem para o titular.
      if (data?.deleted) {
        showToast('Conta excluída.');
        await signOut();
        return;
      }

      showToast(`Solicitação registrada. Exclusão em ${formatIsoDate(data?.scheduledFor)}.`);
      setConfirming(false);
      setProof('');
      // NÃO desloga: a janela de arrependimento só existe se ele continuar
      // entrando e vendo o aviso e o botão de cancelar.
      if (currentTenantId) await checkAccess(currentTenantId, true);
    } finally {
      setSubmitting(false);
    }
  };

  // Telefone é obrigatório aqui (diferente do opcional em Minha Empresa), então
  // compõe a exigência com a validação de formato (11 dígitos + DV nem se aplica,
  // é só tamanho — ver phoneValidationMessage).
  const validateContactPhone = (): string | null => {
    const message = contactPhone.trim()
      ? phoneValidationMessage(unmaskPhone(contactPhone))
      : 'Informe um telefone de contato.';
    setContactPhoneError(message);
    return message;
  };

  const onSubmitPress = () => {
    if (!isOnline) {
      showToast('Precisa de internet para solicitar a exclusão.');
      return;
    }
    // Nome e telefone só existem no caminho do DONO: eles servem para o contato
    // de retenção durante a janela de espera. Quem não é dono é excluído na hora
    // e não tem janela — exigir os campos dele seria pedir dado sem finalidade.
    if (isOwner && !contactName.trim()) {
      showToast('Informe o nome de quem podemos procurar.');
      return;
    }
    if (isOwner) {
      const phoneMessage = validateContactPhone();
      if (phoneMessage) {
        showToast(phoneMessage);
        return;
      }
    }
    if (!proof.trim()) {
      showToast(byPassword ? 'Digite sua senha para confirmar.' : 'Digite seu e-mail para confirmar.');
      return;
    }

    if (!isOwner) {
      // Sem prazo, sem cópia, sem janela de arrependimento: para não-dono o
      // servidor apaga na hora. O aviso precisa dizer isso, e não a data.
      Alert.alert(
        'Excluir sua conta?',
        'Sua conta e o seu cadastro são apagados agora, de forma definitiva. Os dados da empresa ' +
          'não são afetados.\n\nNão há como desfazer.',
        [
          { text: 'Voltar', style: 'cancel' },
          { text: 'Excluir', style: 'destructive', onPress: () => void submit() },
        ],
      );
      return;
    }

    const tail = exportRequested
      ? `, e o arquivo com seus dados será enviado para ${email} nessa data.`
      : '. Nenhum arquivo será enviado.';
    Alert.alert(
      'Confirmar solicitação?',
      `A conta e todos os dados da empresa serão excluídos em ${scheduledLabel}${tail}\n\n` +
        'Até lá o app fica só para consulta. Você pode cancelar quando quiser.',
      [
        { text: 'Voltar', style: 'cancel' },
        { text: 'Confirmar', style: 'destructive', onPress: () => void submit() },
      ],
    );
  };

  const onCancelRequest = () => {
    Alert.alert(
      'Cancelar a solicitação?',
      'Sua conta continua ativa e o app volta a funcionar normalmente. Nada foi excluído.',
      [
        { text: 'Voltar', style: 'cancel' },
        // Sem `destructive`: cancelar a exclusão é a ação BOA. Pintá-la de
        // vermelho ensinaria exatamente a coisa errada.
        {
          text: 'Cancelar solicitação',
          onPress: () => {
            if (!currentTenantId) return;
            setCanceling(true);
            void (async () => {
              const { error } = await cancelDeletion(currentTenantId);
              setCanceling(false);
              showToast(error ?? 'Solicitação cancelada. O app voltou ao normal.');
            })();
          },
        },
      ],
    );
  };

  const closePanel = () => {
    setConfirming(false);
    setProof('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.label}>E-mail</Text>
          <Text style={styles.value}>{email || '—'}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.label}>Empresa ativa</Text>
          <Text style={styles.value}>
            {currentTenantId ? 'Vinculada ✓' : 'Aguardando 1º sync online'}
          </Text>
        </View>

        {/* Já existe solicitação: nenhum caminho de exclusão fica aberto junto. */}
        {deletion ? (
          <View style={styles.pendingCard}>
            <Text style={styles.pendingTitle}>⏱ Exclusão agendada</Text>
            <InfoLine label="Solicitado em" value={formatIsoDateTime(deletion.requestedAt)} />
            <InfoLine label="Exclusão prevista" value={formatIsoDate(deletion.scheduledFor)} />
            <InfoLine
              label={deletion.exportRequested ? 'Envio dos dados' : 'Cópia dos dados'}
              value={
                deletion.exportRequested
                  ? `${formatIsoDate(deletion.scheduledFor)} → ${deletion.contactEmail ?? email}`
                  : 'Não solicitada'
              }
            />
            <View style={styles.divider} />
            <Text style={styles.pendingText}>
              Até essa data o app fica só para consulta: você vê tudo, mas não registra vendas nem
              edita cadastros.
            </Text>
            {deletion.canCancel && (
              <View style={styles.actions}>
                <Button
                  title="Cancelar solicitação"
                  variant="gold"
                  onPress={onCancelRequest}
                  loading={canceling}
                />
              </View>
            )}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button title="Sair da conta" variant="outline" onPress={onLogout} />
          {!confirming && !deletion && (
            <Button title="Excluir conta" variant="text" onPress={openPanel} />
          )}
        </View>

        {/* NÃO-DONO: a exclusão dele é IMEDIATA no servidor (caminho 2 da
            delete-account) — some só o acesso dele, a empresa do patrão não é
            tocada. Mostrar aqui o formulário de agendamento seria prometer um
            prazo e uma cópia por e-mail que não vão acontecer. */}
        {confirming && !deletion && !isOwner && (
          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Excluir minha conta</Text>
            <Text style={styles.dangerText}>
              Apaga a sua conta e o seu cadastro de forma definitiva, agora. Não há como desfazer.
            </Text>
            <Text style={styles.dangerText}>
              Os dados da empresa não são afetados — some apenas o seu acesso. As vendas que você
              registrou continuam no histórico do responsável.
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
            <View style={styles.actions}>
              <Button
                title="Excluir minha conta"
                variant="danger"
                onPress={onSubmitPress}
                loading={submitting}
              />
              <Button title="Voltar" variant="outline" onPress={closePanel} />
            </View>
          </View>
        )}

        {confirming && !deletion && isOwner && (
          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Excluir conta e empresa</Text>
            <Text style={styles.dangerText}>
              Apaga a sua conta e todos os dados da empresa — produtos, estoque, vendas, comandas e
              o acesso de toda a equipe. Não há como desfazer.
            </Text>
            <Text style={styles.dangerText}>
              A conta NÃO é excluída agora. Você escolhe a data abaixo e, até ela chegar, o app fica
              só para consulta — dá para cancelar quando quiser.
            </Text>

            {/* NÃO há atalho para "Exportar dados" aqui de propósito: como aquela
                tela também virou uma SOLICITAÇÃO (MIGRATION_25), um botão dessse
                tipo colocaria duas solicitações concorrentes no mesmo formulário,
                competindo com a opção logo abaixo. Quem está excluindo e quer a
                cópia usa a opção; quem só quer a cópia usa Mais > Exportar dados. */}
            <View style={styles.divider} />

            <Text style={styles.groupLabel}>1. Quer receber uma cópia dos seus dados?</Text>
            <View style={styles.options}>
              <OptionRow
                label="Sim, quero receber por e-mail"
                hint={`Enviamos para ${email} e excluímos a conta em ${formatIsoDate(dates.withExport)}.`}
                selected={exportRequested}
                onPress={() => setExportRequested(true)}
                accessibilityLabel={`Sim, quero receber por e-mail. Exclusão em ${formatIsoDateLong(dates.withExport)}.`}
              />
              <OptionRow
                label="Não, pode excluir sem enviar nada"
                hint={`Excluímos a conta em ${formatIsoDateTime(dates.noExport)}.`}
                selected={!exportRequested}
                onPress={() => setExportRequested(false)}
                accessibilityLabel={`Não, pode excluir sem enviar nada. Exclusão em ${formatIsoDateLong(dates.noExport)}.`}
              />
            </View>

            <Text style={styles.groupLabel}>2. Com quem falamos sobre essa solicitação?</Text>
            <View style={styles.field}>
              <TextField
                label="Nome do responsável"
                value={contactName}
                onChangeText={setContactName}
                autoCapitalize="words"
                returnKeyType="done"
                blurOnSubmit
              />
            </View>
            <View style={styles.field}>
              <TextField
                label="Telefone (WhatsApp)"
                value={contactPhone}
                onChangeText={(t) => {
                  setContactPhone(formatPhoneInput(t));
                  if (contactPhoneError) setContactPhoneError(null);
                }}
                onBlur={validateContactPhone}
                keyboardType="phone-pad"
                maxLength={15}
                error={contactPhoneError ?? undefined}
                returnKeyType="done"
                blurOnSubmit
              />
            </View>

            <Text style={styles.groupLabel}>3. Confirme que é você</Text>
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
                  // A tecla do teclado apenas fecha o teclado: solicitar a
                  // exclusão é ação do botão, nunca de um toque na tecla verde.
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

            <View style={styles.summary}>
              <Text style={styles.summaryTitle}>Exclusão prevista: {scheduledLabel}</Text>
              <Text style={styles.summaryText}>
                {exportRequested
                  ? `Enviamos o arquivo com seus dados para ${email} nessa data.`
                  : 'Nenhum arquivo será enviado.'}
              </Text>
            </View>

            <View style={styles.actions}>
              {/* A data no RÓTULO do botão é a proteção principal: quem não leu
                  nada lê o que está escrito no botão que vai apertar. */}
              <Button
                title={
                  scheduledDate
                    ? `Solicitar exclusão (${formatIsoDate(scheduledDate)})`
                    : 'Solicitar exclusão'
                }
                variant="danger"
                onPress={onSubmitPress}
                loading={submitting}
              />
              <Button title="Voltar" variant="outline" onPress={closePanel} />
            </View>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoLine}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
  label: { color: colors.textSecondary, fontSize: 13 },
  value: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginTop: spacing.xs },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
  dangerCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  dangerTitle: { color: colors.danger, fontSize: fontSizes.body, fontWeight: '700' },
  // Corpo em 16: o repo exige >= 16 (RNF-05) e o texto mais consequente do app
  // estava em 13.
  dangerText: { color: colors.textSecondary, fontSize: fontSizes.body, lineHeight: 22 },
  groupLabel: {
    color: colors.textPrimary,
    fontSize: fontSizes.body,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  options: { gap: spacing.sm },
  field: { marginTop: spacing.xs },
  divider: { height: 1, backgroundColor: colors.divider, marginVertical: spacing.sm },
  summary: {
    marginTop: spacing.md,
    backgroundColor: colors.surfaceHover,
    borderLeftWidth: 3,
    borderLeftColor: colors.yellow,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  summaryTitle: { color: colors.textPrimary, fontSize: fontSizes.body, fontWeight: '700' },
  summaryText: { color: colors.textSecondary, fontSize: fontSizes.label, marginTop: spacing.xs },
  pendingCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.yellow,
    padding: spacing.md,
  },
  pendingTitle: {
    color: colors.yellow,
    fontSize: fontSizes.body,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  pendingText: { color: colors.textSecondary, fontSize: fontSizes.body, lineHeight: 22 },
  infoLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  infoLabel: { color: colors.textSecondary, fontSize: fontSizes.label },
  infoValue: {
    color: colors.textPrimary,
    fontSize: fontSizes.label,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
});
