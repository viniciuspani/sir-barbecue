import { secureStorage } from '@/services/secureStorage';

// Flag local (por usuário) que marca se a tela de boas-vindas já foi exibida.
// Escopo por userId para não "vazar" onboarding entre contas no mesmo aparelho.
const key = (userId: string) => `onboarding.welcome.${userId}`;

export async function hasSeenWelcome(userId: string): Promise<boolean> {
  return (await secureStorage.get(key(userId))) === '1';
}

export async function markWelcomeSeen(userId: string): Promise<void> {
  await secureStorage.set(key(userId), '1');
}
