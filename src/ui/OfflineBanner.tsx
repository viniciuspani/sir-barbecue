import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/design/tokens';
import { useConnectivityStore } from '@/store/connectivityStore';

// Indicador visual de offline (doc 01c §10.4). Visível só quando offline.
export function OfflineBanner() {
  const isOnline = useConnectivityStore((s) => s.isOnline);
  const insets = useSafeAreaInsets();

  if (isOnline) return null;

  return (
    <View style={[styles.banner, { paddingTop: insets.top + 6 }]}>
      <Text style={styles.text}>Modo offline — vendas salvas localmente</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.red, paddingHorizontal: 16, paddingBottom: 6 },
  text: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', textAlign: 'center' },
});
