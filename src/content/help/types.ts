import type { Ionicons } from '@expo/vector-icons';

import type { FlowNode } from '@/ui/flow/FlowChart';

export type HelpStep = {
  title: string;
  detail: string;
};

// Espelha o RBAC de src/lib/permissions.ts: some/all das telas por trás de um
// tópico exigem owner/manager. Sem `requires` = visível a todos os membros.
export type HelpRequirement = 'products' | 'stock' | 'suppliers' | 'reports';

export type HelpTopic = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  intro: string;
  flow: FlowNode[];
  steps: HelpStep[];
  tips?: string[];
  requires?: HelpRequirement;
};
