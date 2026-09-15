import { Redirect, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fontSizes, radii, spacing } from '@/design/tokens';
import { formatIsoDate, formatIsoDateTime } from '@/lib/dates';
import { usePermissions } from '@/lib/permissions';
import { showToast } from '@/lib/toast';
import {
  type DataExportRequest,
  listDataExportRequests,
  requestDataExport,
} from '@/services/functions';
import { useAccessStore } from '@/store/accessStore';
import { Button } from '@/ui/Button';

const ITENS = [
  'Vendas e itens de venda',
  'Comandas',
  'Estoque (saldo atual e movimentações)',
  'Fornecedores e custo de compra',
  'Produtos e categorias',
  'Pagamentos da assinatura',
  'Relatórios já gerados',
];

const STATUS_LABEL: Record<DataExportRequest['status'], string> = {
  pending: 'Na fila',
  ready: 'Arquivo pronto',
  sent: 'Enviado por e-mail',
  delivered: 'Entregue',
  failed: 'Falhou — vamos te procurar',
};

const STATUS_COLOR: Record<DataExportRequest['status'], string> = {
  pending: colors.yellow,
  ready: colors.yellow,
  sent: colors.green,
  delivered: colors.green,
  failed: colors.danger,
};

/**
 * Exportação de dados — SOLICITAÇÃO, não download (MIGRATION_25).
 *
 * Antes esta tela montava o zip e baixava na hora: o cliente ficava travado
 * esperando o servidor varrer o banco e depois puxava o arquivo inteiro pelo 4G.
 * Agora ela só entra na fila do worker que já roda de hora em hora, e o arquivo
 * chega por e-mail. A tela passa a mostrar o andamento.
 */
export default function ExportarDados() {
  const { canAccessExport } = usePermissions();
  const deletion = useAccessStore((s) => s.deletion);
  const [requesting, setRequesting] = useState(false);
  const [requests, setRequests] = useState<DataExportRequest[]>([]);

  const refresh = useCallback(() => {
    void listDataExportRequests().then(setRequests);
  }, []);

  // Recarrega ao focar: o worker pode ter processado enquanto a tela esteve fora.
  useFocusEffect(refresh);

  const emFila = requests.some((r) => r.status === 'pending');

  const onRequest = async () => {
    setRequesting(true);
    const { data, error } = await requestDataExport();
    setRequesting(false);
    if (error) {
      showToast(error);
      return;
    }
    showToast(
      data?.alreadyQueued
        ? 'Você já tem uma solicitação na fila.'
        : 'Solicitação registrada. O arquivo chega por e-mail.',
    );
    refresh();
  };

  // employee/manager não acessam esta tela (guarda de deep-link; a RLS confirma no servidor).
  if (!canAccessExport) return <Redirect href="/mais" />;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {/* Com a exclusão agendada, pedir a cópia continua liberado de propósito:
          é leitura de dado próprio, e é o caso de quem escolheu "sem exportação"
          e mudou de ideia. */}
      {deletion ? (
        <View style={styles.warn}>
          <Text style={styles.warnText}>
            Sua conta será excluída em {formatIsoDate(deletion.scheduledFor)}. Se quiser uma cópia
            dos dados antes disso, peça aqui.
          </Text>
        </View>
      ) : null}

      <Text style={styles.section}>O que vai no arquivo</Text>
      <View style={styles.block}>
        {ITENS.map((item) => (
          <View key={item} style={styles.row}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.rowLabel}>{item}</Text>
          </View>
        ))}
      </View>

      <Button
        title={emFila ? 'Solicitação já registrada' : 'Solicitar cópia dos dados'}
        onPress={() => void onRequest()}
        loading={requesting}
        disabled={emFila}
      />
      <Text style={styles.hint}>
        Preparamos um arquivo .zip com uma planilha (.csv) para cada item acima e enviamos para o
        seu e-mail em até 48 horas — normalmente em menos de uma hora. Você não precisa ficar com o
        app aberto.
      </Text>

      {requests.length > 0 && (
        <>
          <Text style={styles.section}>Suas solicitações</Text>
          <View style={styles.block}>
            {requests.map((r) => (
              <View key={r.id} style={styles.requestRow}>
                <View style={styles.requestTexts}>
                  <Text style={styles.requestDate}>{formatIsoDateTime(r.createdAt)}</Text>
                  {r.contactEmail ? (
                    <Text style={styles.requestEmail}>para {r.contactEmail}</Text>
                  ) : null}
                </View>
                <Text style={[styles.requestStatus, { color: STATUS_COLOR[r.status] }]}>
                  {STATUS_LABEL[r.status]}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  section: { color: colors.textPrimary, fontSize: 16, fontWeight: '600', marginBottom: spacing.sm },
  block: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  row: { flexDirection: 'row', gap: spacing.sm },
  bullet: { color: colors.gold, fontSize: 15 },
  rowLabel: { flex: 1, color: colors.textSecondary, fontSize: 15 },
  hint: { color: colors.textSecondary, fontSize: 13, marginTop: spacing.md, lineHeight: 19 },
  warn: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.yellow,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  warnText: { color: colors.yellow, fontSize: 15, fontWeight: '600', lineHeight: 21 },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  requestTexts: { flex: 1 },
  requestDate: { color: colors.textPrimary, fontSize: fontSizes.label, fontWeight: '600' },
  requestEmail: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  requestStatus: { fontSize: 12, fontWeight: '700', textAlign: 'right', flexShrink: 1 },
});
