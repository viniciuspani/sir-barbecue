import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

import { colors, radii, spacing } from '@/design/tokens';
import { formatDatePtBR } from '@/lib/dates';
import { Button } from '@/ui/Button';

type Props = {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  minimumDate?: Date;
  maximumDate?: Date;
};

/** Campo de data nativo (Android: diálogo do sistema; iOS: calendário inline). */
export function DateField({ label, value, onChange, minimumDate, maximumDate }: Props) {
  const [showIOS, setShowIOS] = useState(false);

  const open = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value,
        mode: 'date',
        minimumDate,
        maximumDate,
        onChange: (_event, date) => {
          if (date) onChange(date);
        },
      });
      return;
    }
    setShowIOS(true);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={open} style={styles.field} accessibilityRole="button">
        <Text style={styles.value}>{formatDatePtBR(value)}</Text>
      </Pressable>
      {showIOS && (
        <View style={styles.iosPicker}>
          <DateTimePicker
            value={value}
            mode="date"
            display="inline"
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            onChange={(_event, date) => {
              if (date) onChange(date);
            }}
          />
          <Button title="Concluído" variant="text" onPress={() => setShowIOS(false)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  label: { color: colors.textSecondary, fontSize: 13, marginBottom: spacing.xs },
  field: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.divider,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  value: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  iosPicker: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginTop: spacing.sm,
    padding: spacing.sm,
  },
});
