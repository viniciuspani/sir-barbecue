import { StyleSheet, View } from 'react-native';
import Svg, { Line, Polygon } from 'react-native-svg';

import { colors } from '@/design/tokens';

const HEIGHT = 28;
const WIDTH = 24;

/** Conector vertical entre dois nós do fluxograma: linha + ponta de seta. */
export function FlowArrow() {
  return (
    <View style={styles.wrap}>
      <Svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        <Line
          x1={WIDTH / 2}
          y1={0}
          x2={WIDTH / 2}
          y2={HEIGHT - 8}
          stroke={colors.gold}
          strokeWidth={2}
        />
        <Polygon
          points={`${WIDTH / 2 - 6},${HEIGHT - 8} ${WIDTH / 2 + 6},${HEIGHT - 8} ${WIDTH / 2},${HEIGHT}`}
          fill={colors.gold}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
});
