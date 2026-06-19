import { View, Text, StyleSheet } from 'react-native';

import { colors } from '@/design/tokens';

/**
 * Splash / gate de sessão.
 * Fase 1 implementa o redirect para `(auth)` ou `(app)` conforme a sessão (authStore).
 */
export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Sir Barbecue</Text>
      <Text style={styles.tagline}>La Brasa Espetinhos</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  brand: { color: colors.gold, fontSize: 28, fontWeight: '700' },
  tagline: { color: colors.textSecondary, fontSize: 16, marginTop: 8 },
});
