import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

type Props = {
  html: string;
};

/** Exibe o HTML do relatório gerado no servidor. Nativo: WebView do sistema, sem JS/storage. */
export function ReportViewer({ html }: Props) {
  return (
    <WebView
      source={{ html }}
      style={styles.flex}
      originWhitelist={['about:']}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
    />
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
