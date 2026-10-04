import { colors } from '@/design/tokens';

type Props = {
  visible: boolean;
  onRequestClose: () => void;
  children: React.ReactNode;
};

/**
 * Na web, o `Modal` do RN (via react-native-web) vira um `<dialog>` dimensionado
 * ao conteúdo e centralizado — aparece como um cartão pequeno flutuando sobre a
 * tela, diferente do resto do app (que ocupa a página inteira). Aqui cobrimos a
 * viewport inteira, do mesmo jeito que as outras telas.
 */
export function FullscreenModal({ visible, children }: Props) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        backgroundColor: colors.bg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}
