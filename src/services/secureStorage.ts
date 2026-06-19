import * as SecureStore from 'expo-secure-store';

// Wrapper de armazenamento seguro (Keychain iOS / Keystore Android) — RNF-07.
export const secureStorage = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  remove: (key: string) => SecureStore.deleteItemAsync(key),
};
