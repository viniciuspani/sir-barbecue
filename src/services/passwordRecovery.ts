import { secureStorage } from '@/services/secureStorage';

// Flag GLOBAL (não por usuário) que marca "recuperação de senha em andamento".
// O link do e-mail cria uma sessão VÁLIDA antes de o usuário definir a nova senha;
// sem essa marca, o gate de (auth)/(app) lê a sessão como um login normal e joga a
// pessoa para dentro do app — justamente o que a recuperação precisa impedir.
// Persistida (não só em memória) para que matar o app no meio do fluxo não deixe a
// sessão de recovery valendo como login.
const KEY = 'auth.passwordRecoveryPending';

export async function isPasswordRecoveryPending(): Promise<boolean> {
  try {
    return (await secureStorage.get(KEY)) === '1';
  } catch {
    return false;
  }
}

export async function markPasswordRecoveryPending(): Promise<void> {
  try {
    await secureStorage.set(KEY, '1');
  } catch {
    // ignore — a flag em memória (authStore) já cobre a sessão atual
  }
}

export async function clearPasswordRecoveryPending(): Promise<void> {
  try {
    await secureStorage.remove(KEY);
  } catch {
    // ignore
  }
}
