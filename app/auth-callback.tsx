import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { supabase } from '@/data/remote/supabaseClient';
import { Splash } from '@/ui/Splash';

/**
 * Handler do deep link do OAuth (Google): `sirbarbecue://auth-callback?code=...`.
 * Troca o `code` (PKCE) por uma sessão e redireciona. A sessão dispara o onAuthStateChange,
 * e o gate em (app)/(auth) cuida do resto.
 */
export default function AuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error_description?: string }>();
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;

    (async () => {
      const code = typeof params.code === 'string' ? params.code : undefined;
      if (!code) {
        if (active) setFailed(true);
        return;
      }

      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!active) return;

      if (error) {
        // O code pode já ter sido trocado (ex.: o navegador também interceptou).
        // Se já houver sessão, consideramos sucesso.
        const { data } = await supabase.auth.getSession();
        if (active) (data.session ? setDone : setFailed)(true);
      } else {
        setDone(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [params.code]);

  if (failed) return <Redirect href="/(auth)/login" />;
  if (done) return <Redirect href="/(app)" />;
  return <Splash />;
}
