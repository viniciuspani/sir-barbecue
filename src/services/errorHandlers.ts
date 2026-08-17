import { logError } from '@/services/errorLog';

/**
 * Captura AUTOMÁTICA de erros não tratados — a rede de segurança do log.
 *
 * Cobre o que nenhum `catch` alcança:
 *   • crash de JavaScript (ErrorUtils);
 *   • promise rejeitada sem `.catch` (a causa mais comum de "sumiu e não fez nada").
 *
 * A terceira frente — erro durante o render — é o `ErrorBoundary` exportado em
 * app/_layout.tsx, que o Expo Router usa no lugar da tela branca.
 *
 * Instalado UMA vez, no boot do app.
 */

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

type ErrorUtilsShape = {
  getGlobalHandler?: () => GlobalErrorHandler;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
};

type HermesShape = {
  hasPromise?: () => boolean;
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
};

let installed = false;

function installCrashHandler(): void {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;

  // Encadeia o handler anterior: em dev o LogBox continua mostrando o redbox,
  // e em produção a tela de crash padrão do RN segue funcionando.
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    void logError(error, {
      action: isFatal ? 'Falha grave no aplicativo' : 'Erro não tratado',
      severity: isFatal ? 'fatal' : 'error',
    });
    previous?.(error, isFatal);
  });
}

function installRejectionHandler(): void {
  const onUnhandled = (rejection: unknown): void => {
    void logError(rejection, { action: 'Operação em segundo plano', severity: 'error' });
  };

  const hermes = (globalThis as { HermesInternal?: HermesShape }).HermesInternal;
  if (hermes?.hasPromise?.() && hermes.enablePromiseRejectionTracker) {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (_id, rejection) => onUnhandled(rejection),
    });
    return;
  }

  // Motor sem Hermes: o RN usa o polyfill `promise`, que tem rastreio próprio.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tracking = require('promise/setimmediate/rejection-tracking') as {
      enable: (options: {
        allRejections: boolean;
        onUnhandled: (id: number, error: unknown) => void;
        onHandled: () => void;
      }) => void;
    };
    tracking.enable({
      allRejections: true,
      onUnhandled: (_id, error) => onUnhandled(error),
      onHandled: () => undefined,
    });
  } catch (e) {
    console.warn('[errorHandlers] rastreio de promises indisponível', e);
  }
}

/** Instala os handlers globais. Idempotente — chamar mais de uma vez não duplica. */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  installCrashHandler();
  installRejectionHandler();
}
