import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { supplierRepository } from '@/data/repositories';
import { colors, spacing } from '@/design/tokens';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

export default function FornecedorForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!id;

  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    supplierRepository
      .getById(id)
      .then((s) => {
        if (!s) return;
        setName(s.name);
        setContactName(s.contactName ?? '');
        setPhone(s.phone ?? '');
        setAddress(s.address ?? '');
      })
      .catch(() => undefined);
  }, [id]);

  const onSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Informe o nome do fornecedor.');
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      contactName: contactName.trim() || undefined,
      phone: phone.trim() || undefined,
      address: address.trim() || undefined,
    };
    if (isEdit && id) await supplierRepository.update(id, payload);
    else await supplierRepository.create(payload);
    setSaving(false);
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TextField
        label="Nome"
        value={name}
        onChangeText={setName}
        placeholder="ex.: Distribuidora Central"
        autoCapitalize="words"
      />
      <TextField
        label="Contato — opcional"
        value={contactName}
        onChangeText={setContactName}
        placeholder="nome do contato"
        autoCapitalize="words"
      />
      <TextField
        label="Telefone — opcional"
        value={phone}
        onChangeText={setPhone}
        placeholder="(00) 00000-0000"
        keyboardType="phone-pad"
      />
      <TextField
        label="Endereço — opcional"
        value={address}
        onChangeText={setAddress}
        placeholder="rua, número, bairro"
      />

      {!!error && <Text style={styles.error}>{error}</Text>}

      <Button title={isEdit ? 'Salvar alterações' : 'Cadastrar fornecedor'} onPress={onSave} loading={saving} />
      <Button title="Cancelar" variant="text" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  error: { color: colors.danger, fontSize: 14, marginVertical: spacing.sm },
});
