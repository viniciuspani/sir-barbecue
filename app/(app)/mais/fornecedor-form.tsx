import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { supplierRepository } from '@/data/repositories';
import type { Supplier } from '@/domain/entities/Supplier';
import { colors, spacing } from '@/design/tokens';
import { logSilently, reportError } from '@/lib/feedback';
import { usePermissions } from '@/lib/permissions';
import { formatPhoneInput, phoneValidationMessage, unmaskPhone } from '@/lib/phone';
import { showToast } from '@/lib/toast';
import { Button } from '@/ui/Button';
import { TextField } from '@/ui/TextField';

// Mesmos limites do banco (suppliers.name/contact_name varchar(200)).
const MAX_SUPPLIER_NAME_LENGTH = 200;
const MAX_CONTACT_NAME_LENGTH = 200;
// suppliers.address é `text` (sem limite no banco) — teto só de UX, mesma
// ordem de grandeza dos outros campos de texto livre do cadastro.
const MAX_ADDRESS_LENGTH = 200;

export default function FornecedorForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!id;
  const { canWriteSuppliers, readOnlyReason } = usePermissions();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactNameError, setContactNameError] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => supplierRepository.observeAll(setSuppliers), []);

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
      .catch((e) => logSilently(e, { action: 'Carregar o fornecedor para edição' }));
  }, [id]);

  // Comparação EXATA (sem normalizar caixa/acentos) porque é assim que o banco
  // compara: constraint suppliers_name_tenant_unique = unique (tenant_id, name).
  // Mesmo padrão de ProdutoForm.
  const validateName = (): string | null => {
    const trimmed = name.trim();
    let blockingMessage: string | null = null;
    if (!trimmed) {
      blockingMessage = 'Informe o nome do fornecedor.';
    } else if (name.length > MAX_SUPPLIER_NAME_LENGTH) {
      blockingMessage = `Nome muito longo — o máximo é ${MAX_SUPPLIER_NAME_LENGTH} caracteres.`;
    } else if (suppliers.some((s) => s.name === trimmed && s.id !== id)) {
      blockingMessage = 'Já existe um fornecedor cadastrado com esse nome.';
    }
    const displayMessage =
      blockingMessage ??
      (name.length >= MAX_SUPPLIER_NAME_LENGTH
        ? `Limite de ${MAX_SUPPLIER_NAME_LENGTH} caracteres atingido.`
        : null);
    setNameError(displayMessage);
    return blockingMessage;
  };

  const onChangeName = (t: string) => {
    setName(t);
    setNameError(
      t.length >= MAX_SUPPLIER_NAME_LENGTH
        ? `Limite de ${MAX_SUPPLIER_NAME_LENGTH} caracteres atingido.`
        : null,
    );
  };

  // contact_name/address são opcionais — nunca bloqueiam por estarem vazios,
  // só por passar do limite. O maxLength do campo trava a digitação NOVA, mas
  // não encurta um valor que já veio maior (registro salvo local antes desta
  // validação existir — o SQLite não impõe o varchar do Postgres).
  const validateContactName = (): string | null => {
    let blockingMessage: string | null = null;
    if (contactName.length > MAX_CONTACT_NAME_LENGTH) {
      blockingMessage = `Nome muito longo — o máximo é ${MAX_CONTACT_NAME_LENGTH} caracteres.`;
    }
    const displayMessage =
      blockingMessage ??
      (contactName.length >= MAX_CONTACT_NAME_LENGTH
        ? `Limite de ${MAX_CONTACT_NAME_LENGTH} caracteres atingido.`
        : null);
    setContactNameError(displayMessage);
    return blockingMessage;
  };

  const validateAddress = (): string | null => {
    let blockingMessage: string | null = null;
    if (address.length > MAX_ADDRESS_LENGTH) {
      blockingMessage = `Endereço muito longo — o máximo é ${MAX_ADDRESS_LENGTH} caracteres.`;
    }
    const displayMessage =
      blockingMessage ??
      (address.length >= MAX_ADDRESS_LENGTH ? `Limite de ${MAX_ADDRESS_LENGTH} caracteres atingido.` : null);
    setAddressError(displayMessage);
    return blockingMessage;
  };

  // Roda ao sair do campo (feedback imediato) e de novo ao salvar — mesmo
  // padrão do CNPJ/Telefone em Minha Empresa.
  const validatePhone = (): string | null => {
    const message = phoneValidationMessage(unmaskPhone(phone));
    setPhoneError(message);
    return message;
  };

  const onSave = async () => {
    setError(null);
    const nameMessage = validateName();
    if (nameMessage) {
      showToast(nameMessage);
      return;
    }
    const phoneMessage = validatePhone();
    if (phoneMessage) {
      showToast(phoneMessage);
      return;
    }
    const contactNameMessage = validateContactName();
    if (contactNameMessage) {
      showToast(contactNameMessage);
      return;
    }
    const addressMessage = validateAddress();
    if (addressMessage) {
      showToast(addressMessage);
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      contactName: contactName.trim() || undefined,
      phone: phone.trim() || undefined,
      address: address.trim() || undefined,
    };
    try {
      if (isEdit && id) await supplierRepository.update(id, payload);
      else await supplierRepository.create(payload);
      router.back();
    } catch (e) {
      await reportError(e, {
        action: isEdit ? 'Salvar alterações do fornecedor' : 'Cadastrar fornecedor',
        meta: { supplierId: id ?? null },
      });
    } finally {
      setSaving(false);
    }
  };

  // Só owner escreve fornecedores (guarda de deep-link; a RLS confirma no servidor).
  if (!canWriteSuppliers) return <Redirect href="/mais" />;

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TextField
        label="Nome"
        value={name}
        onChangeText={onChangeName}
        onBlur={validateName}
        maxLength={MAX_SUPPLIER_NAME_LENGTH}
        placeholder="ex.: Distribuidora Central"
        autoCapitalize="words"
        error={nameError ?? undefined}
      />
      <TextField
        label="Contato — opcional"
        value={contactName}
        onChangeText={(t) => {
          setContactName(t);
          setContactNameError(
            t.length >= MAX_CONTACT_NAME_LENGTH
              ? `Limite de ${MAX_CONTACT_NAME_LENGTH} caracteres atingido.`
              : null,
          );
        }}
        onBlur={validateContactName}
        maxLength={MAX_CONTACT_NAME_LENGTH}
        placeholder="nome do contato"
        autoCapitalize="words"
        error={contactNameError ?? undefined}
      />
      <TextField
        label="Telefone — opcional"
        value={phone}
        onChangeText={(t) => {
          setPhone(formatPhoneInput(t));
          if (phoneError) setPhoneError(null);
        }}
        onBlur={validatePhone}
        placeholder="(00) 00000-0000"
        keyboardType="phone-pad"
        maxLength={15}
        error={phoneError ?? undefined}
      />
      <TextField
        label="Endereço — opcional"
        value={address}
        onChangeText={(t) => {
          setAddress(t);
          setAddressError(
            t.length >= MAX_ADDRESS_LENGTH ? `Limite de ${MAX_ADDRESS_LENGTH} caracteres atingido.` : null,
          );
        }}
        onBlur={validateAddress}
        maxLength={MAX_ADDRESS_LENGTH}
        placeholder="rua, número, bairro"
        error={addressError ?? undefined}
      />

      {!!error && <Text style={styles.error}>{error}</Text>}

      <Button
        title={isEdit ? 'Salvar alterações' : 'Cadastrar fornecedor'}
        onPress={onSave}
        loading={saving}
        disabledReason={readOnlyReason ?? undefined}
      />
      <Button title="Cancelar" variant="text" onPress={() => router.back()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  error: { color: colors.danger, fontSize: 14, marginVertical: spacing.sm },
});
