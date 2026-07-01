import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/design/tokens';

export function Splash() {
  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Sir Barbecue</Text>
      <Text style={styles.tagline}>La Brasa Espetinhos</Text>
      <ActivityIndicator color={colors.gold} style={styles.spinner} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  brand: { color: colors.gold, fontSize: 28, fontWeight: '700' },
  tagline: { color: colors.textSecondary, fontSize: 16, marginTop: 8 },
  spinner: { marginTop: 24 },
});
