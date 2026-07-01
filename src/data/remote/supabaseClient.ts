import 'react-native-url-polyfill/auto';

import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

// Persiste a sessão do Supabase Auth no Keychain (iOS) / Keystore (Android) — RNF-07.
// NOTA: expo-secure-store tem limite de ~2KB por valor; sessões grandes podem exigir
// um adapter com "chunking". Suficiente para o esqueleto.
const SecureStorageAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  // Sem credenciais ainda. Usamos placeholders para o createClient não lançar no import —
  // auth/sync ficam indisponíveis até configurar o .env (ver docs/plano/FASE_2_SETUP_SUPABASE.md).
  console.warn(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL/ANON_KEY ausentes — usando placeholder (auth/sync off até configurar o .env).',
  );
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'public-anon-placeholder',
  {
    auth: {
      storage: SecureStorageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce', // OAuth/recuperação de senha em mobile usam PKCE
    },
  },
);
