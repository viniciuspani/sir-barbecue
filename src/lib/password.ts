// Regra de senha para CRIAÇÃO (cadastro e redefinição). Não se aplica ao login:
// contas antigas continuam entrando com a senha que já tinham, só numérica ou
// não — mudar a regra aqui não invalida o que já existe no Supabase Auth.

// Uma conta `owner` comprometida dá acesso a todo o faturamento da empresa e
// pode excluí-la. Alinhado ao mínimo configurado no Supabase — ver A07-01 na
// auditoria de segurança.
export const MIN_PASSWORD_LENGTH = 10;

/** Mensagem para o usuário quando a senha não serve, ou `null` quando está OK. */
export function passwordValidationMessage(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'A senha deve ter letras e números.';
  }
  return null;
}
