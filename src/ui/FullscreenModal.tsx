import { Modal } from 'react-native';

type Props = {
  visible: boolean;
  onRequestClose: () => void;
  children: React.ReactNode;
};

/** Modal de tela cheia. Nativo: `Modal` padrão do RN, já ocupa a tela inteira. */
export function FullscreenModal({ visible, onRequestClose, children }: Props) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onRequestClose}>
      {children}
    </Modal>
  );
}
