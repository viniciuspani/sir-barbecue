import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/data/remote/supabaseClient';
import { useAuthStore } from '@/store/authStore';

async function ensurePermission(prompt: boolean): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return true;
  if (!prompt) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

/**
 * Registra o token de push do device e salva em push_tokens (base do RF-11/22).
 * - prompt=false → só age se a permissão já foi concedida (não mostra prompt);
 *   usado no boot, após login, para manter o token salvo.
 * - prompt=true → pede a permissão; usado no botão "Ativar notificações".
 * Exige development build (não funciona no Expo Go).
 */
export async function registerAndSavePushToken(opts?: {
  prompt?: boolean;
}): Promise<{ token: string | null; error: string | null }> {
  const tenantId = useAuthStore.getState().currentTenantId;
  if (!tenantId) return { token: null, error: 'Sem empresa ativa.' };
  try {
    const granted = await ensurePermission(opts?.prompt ?? false);
    if (!granted) return { token: null, error: 'Permissão de notificação negada.' };

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    // getExpoPushTokenAsync precisa do projectId do EAS em build standalone.
    const easExtra = Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined;
    const projectId = easExtra?.projectId ?? Constants.easConfig?.projectId;
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = result.data;

    const { error } = await supabase
      .from('push_tokens')
      .upsert(
        { tenant_id: tenantId, token, platform: Platform.OS },
        { onConflict: 'user_id,token', ignoreDuplicates: false },
      );
    if (error) return { token, error: error.message };
    return { token, error: null };
  } catch {
    return { token: null, error: 'Push requer development build (não funciona no Expo Go).' };
  }
}
