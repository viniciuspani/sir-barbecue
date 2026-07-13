import { Image, StyleSheet, View, type ViewStyle } from 'react-native';

import { radii, spacing } from '@/design/tokens';

const logo = require('../../assets/logo-header.png');

type Props = {
  /** Tamanho (largura/altura) do logo em px. Padrão 44. */
  size?: number;
  style?: ViewStyle;
};

/**
 * Marca do app no canto superior esquerdo, exibida acima do título das telas.
 * Reaproveita a logo (assets/logo-header.png) em tamanho reduzido.
 */
export function BrandLogo({ size = 44, style }: Props) {
  return (
    <View style={[styles.wrap, style]}>
      <Image
        source={logo}
        style={{ width: size, height: size, borderRadius: radii.sm }}
        resizeMode="contain"
        accessibilityRole="image"
        accessibilityLabel="Sir Barbecue"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start', marginBottom: spacing.sm },
});
