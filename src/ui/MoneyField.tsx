import { maskMoney } from '@/lib/currency';

import { TextField } from './TextField';

type Props = {
  label: string;
  value: string;
  onChangeText: (masked: string) => void;
  placeholder?: string;
  error?: string;
  onBlur?: () => void;
};

/**
 * Campo de valor financeiro com vírgula automática (máscara de centavos).
 * O usuário digita só números; os 2 últimos dígitos viram os centavos.
 */
export function MoneyField({ label, value, onChangeText, placeholder = '0,00', error, onBlur }: Props) {
  return (
    <TextField
      label={label}
      value={value}
      onChangeText={(text) => onChangeText(maskMoney(text))}
      placeholder={placeholder}
      keyboardType="number-pad"
      error={error}
      onBlur={onBlur}
    />
  );
}
