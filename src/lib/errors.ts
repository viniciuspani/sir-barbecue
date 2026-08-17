/**
 * Normalização de erros + catálogo de mensagens para o usuário.
 *
 * Duas responsabilidades complementares:
 *   • normalizeError — extrai TUDO que serve para diagnóstico (stack, code,
 *     details e hint do Postgres/Supabase) para gravar no log;
 *   • toUserMessage — traduz o erro para uma frase educada, clara e objetiva,
 *     sem jargão técnico nem número de código do banco.
 */

export type NormalizedError = {
  /** Mensagem curta (uma linha) — vai para a coluna `message`. */
  message: string;
  /** Mensagem COMPLETA: tipo, stack e campos do PostgREST — coluna `detail`. */
  detail: string;
  /** Código do erro quando existe (ex.: '42501', '23505', 'PGRST301'). */
  code: string | null;
};

// Chaves cujo VALOR nunca pode ir para o log (LGPD / segurança). O erro do
// Supabase às vezes ecoa o corpo da requisição, que pode conter a senha digitada.
const SENSITIVE_KEYS =
  /("?\b(?:password|senha|access_token|refresh_token|api[_-]?key|apikey|authorization|token|secret)\b"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// JWT solto no texto (header.payload.signature).
const JWT = /\beyJ[A-Za-z0-9._-]{10,}/g;

/** Mascara credenciais antes de qualquer gravação. Nunca lança. */
export function redact(text: string): string {
  if (!text) return text;
  try {
    return text
      .replace(SENSITIVE_KEYS, '$1"***"')
      .replace(BEARER, '$1 ***')
      .replace(JWT, '***');
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  return String(value);
}

/**
 * Aceita qualquer coisa que chegue num catch: Error, PostgrestError
 * ({ message, code, details, hint }), AuthError, string ou objeto solto.
 */
export function normalizeError(error: unknown): NormalizedError {
  const parts: string[] = [];
  let message = 'Erro desconhecido';
  let code: string | null = null;

  if (error instanceof Error) {
    message = error.message || error.name;
    parts.push(`${error.name}: ${error.message}`);
    if (error.stack) parts.push(error.stack);
    const rec = error as unknown as Record<string, unknown>;
    code = str(rec.code) ?? str(rec.status);
    if (rec.cause) parts.push(`cause: ${safeStringify(rec.cause)}`);
  } else if (typeof error === 'string') {
    message = error;
    parts.push(error);
  } else {
    const rec = asRecord(error);
    if (rec) {
      message = str(rec.message) ?? str(rec.error) ?? 'Erro sem mensagem';
      code = str(rec.code) ?? str(rec.status);
      parts.push(safeStringify(rec));
    } else {
      parts.push(String(error));
      message = String(error);
    }
  }

  // Campos do PostgREST/Postgres: details e hint costumam trazer a causa real
  // (ex.: nome da constraint violada) e não aparecem em `message`.
  const rec = asRecord(error);
  if (rec) {
    for (const key of ['code', 'details', 'hint', 'status', 'statusCode'] as const) {
      const value = str(rec[key]);
      if (value) parts.push(`${key}: ${value}`);
    }
  }

  return {
    message: redact(message).slice(0, 500),
    detail: redact(parts.join('\n')).slice(0, 8000),
    code,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Texto único do erro para casar com as assinaturas conhecidas. */
function signature(error: unknown): string {
  const { message, detail, code } = normalizeError(error);
  return `${code ?? ''} ${message} ${detail}`;
}

/** Erro de permissão do Postgres/PostgREST: RLS (42501) ou "row-level security". */
export function isPermissionError(error: unknown): boolean {
  return /row-level security|permission denied|42501|\bPGRST301\b/i.test(signature(error));
}

/** Falha de rede/conectividade (o dado continua salvo localmente). */
export function isNetworkError(error: unknown): boolean {
  return /Network request failed|Failed to fetch|network error|ECONN|timeout|AbortError|offline/i.test(
    signature(error),
  );
}

/**
 * Mensagem exibida ao usuário. Educada, clara e objetiva: diz o que houve e o
 * que fazer, sem termo técnico. `action` é o rótulo do que ele tentava fazer.
 */
export function toUserMessage(error: unknown, action?: string): string {
  const sig = signature(error);

  if (isNetworkError(error)) {
    return 'Sem conexão no momento. Seus dados ficam salvos no aparelho e enviamos assim que a internet voltar.';
  }
  if (isPermissionError(error)) {
    return 'Seu perfil não tem permissão para essa ação. Fale com o dono ou o gerente da empresa.';
  }
  if (/stock_items_quantity_check|estoque insuficiente/i.test(sig)) {
    return 'Estoque insuficiente para concluir a venda. Confira o saldo do produto e tente de novo.';
  }
  if (/\b23505\b|duplicate key|unique constraint/i.test(sig)) {
    return 'Já existe um cadastro com esse nome. Use outro nome para continuar.';
  }
  if (/\b23503\b|foreign key/i.test(sig)) {
    return 'Este registro está sendo usado em outro cadastro e não pode ser alterado agora.';
  }
  if (/Invalid login credentials/i.test(sig)) {
    return 'E-mail ou senha incorretos. Confira os dados e tente de novo.';
  }
  if (/Email not confirmed/i.test(sig)) {
    return 'Confirme seu e-mail antes de entrar. Enviamos um link para a sua caixa de entrada.';
  }
  if (/User already registered/i.test(sig)) {
    return 'Este e-mail já está cadastrado. Faça login ou use a opção "Esqueci minha senha".';
  }
  if (/sem empresa ativa|sem vínculo/i.test(sig)) {
    return 'Sua conta ainda não está vinculada a uma empresa. Peça ao dono para enviar um convite.';
  }

  return action
    ? `Não foi possível concluir: ${action}. Já registramos o ocorrido — tente novamente em instantes.`
    : 'Não foi possível concluir a operação. Já registramos o ocorrido — tente novamente em instantes.';
}
