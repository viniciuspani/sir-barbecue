/**
 * Trilha do que o usuário estava fazendo antes do erro.
 *
 * Buffer circular EM MEMÓRIA (nada é persistido por si só): o log de erro anexa
 * os últimos passos ao registro. Sem isto o log saberia apenas a tela final, não
 * o caminho até ela — que é justamente o que responde "o que o usuário fazia".
 */

const MAX_CRUMBS = 20;

export type Breadcrumb = {
  at: number; // epoch ms
  kind: 'screen' | 'action';
  label: string;
};

const crumbs: Breadcrumb[] = [];

/** Rota atual — alimentada pelo root layout a cada navegação. */
let currentScreen: string | null = null;

function push(kind: Breadcrumb['kind'], label: string): void {
  crumbs.push({ at: Date.now(), kind, label });
  if (crumbs.length > MAX_CRUMBS) crumbs.splice(0, crumbs.length - MAX_CRUMBS);
}

/** Registra a navegação. Ignora repetição da mesma rota (re-render não é passo novo). */
export function trackScreen(route: string): void {
  if (!route || route === currentScreen) return;
  currentScreen = route;
  push('screen', route);
}

/** Registra uma ação do usuário (ex.: "Salvou produto", "Abriu comanda"). */
export function trackAction(label: string): void {
  push('action', label);
}

/** Tela em que o usuário está — usada como fallback quando o chamador não informa. */
export function getCurrentScreen(): string | null {
  return currentScreen;
}

/** Cópia dos passos recentes (mais antigo → mais recente). */
export function getBreadcrumbs(): Breadcrumb[] {
  return [...crumbs];
}

/** Limpa a trilha ao trocar de sessão, para não misturar o rastro de dois usuários. */
export function clearBreadcrumbs(): void {
  crumbs.length = 0;
  currentScreen = null;
}
