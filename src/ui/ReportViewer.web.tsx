import { colors } from '@/design/tokens';

type Props = {
  html: string;
};

/**
 * `react-native-webview` não tem implementação para a plataforma web (cai num
 * componente vazio). Na web usamos um `<iframe>` puro com `srcDoc`, sandboxado
 * sem scripts — mesmo isolamento do `javaScriptEnabled={false}` da versão nativa.
 */
export function ReportViewer({ html }: Props) {
  return (
    <iframe
      srcDoc={html}
      title="Relatório"
      sandbox=""
      style={{ flex: 1, width: '100%', border: 'none', backgroundColor: colors.bg }}
    />
  );
}
