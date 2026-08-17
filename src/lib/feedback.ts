import { Alert } from 'react-native';

import { toUserMessage } from '@/lib/errors';
import { logError, type LogOptions } from '@/services/errorLog';

/**
 * Feedback de ERRO ao usuário — o par visível do log em banco.
 *
 * Toda falha vira duas coisas: um registro técnico completo (services/errorLog)
 * e uma frase educada, clara e objetiva na tela. O código de referência liga as
 * duas: o cliente lê "Código: 7F3A" e o suporte acha a ocorrência exata.
 *
 * Para feedback de SUCESSO continue usando o showToast (lib/toast).
 */

const DEFAULT_TITLE = 'Não foi possível concluir';

/** Alerta amigável com o código de referência do registro no log. */
export function showErrorAlert(userMessage: string, refCode: string, title = DEFAULT_TITLE): void {
  Alert.alert(title, `${userMessage}\n\nCódigo: ${refCode}`, [{ text: 'OK' }]);
}

type ReportOptions = LogOptions & {
  /** Sobrescreve a mensagem do catálogo quando a tela sabe explicar melhor. */
  userMessage?: string;
  /** Título do alerta (padrão: "Não foi possível concluir"). */
  title?: string;
};

/**
 * Registra o erro E avisa o usuário. É o helper de uma linha para o `catch` de
 * qualquer ação disparada por ele (salvar, excluir, fechar venda).
 */
export async function reportError(error: unknown, options: ReportOptions = {}): Promise<string> {
  const userMessage = options.userMessage ?? toUserMessage(error, options.action);
  const refCode = await logError(error, { ...options, userMessage });
  showErrorAlert(userMessage, refCode, options.title);
  return refCode;
}

/**
 * Registra o erro SEM interromper o usuário. Para falhas de carregamento de tela
 * e rotinas de fundo (sync), onde um alerta seria ruído no meio do atendimento.
 */
export function logSilently(error: unknown, options: LogOptions = {}): void {
  void logError(error, options);
}
