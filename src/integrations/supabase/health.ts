import { createClient } from '@supabase/supabase-js';

type SupabaseHealthResult = {
  env: {
    urlPresent: boolean;
    anonKeyPresent: boolean;
  };
  authServiceReachable: boolean;
  message?: string;
};

export async function supabaseHealthCheck(): Promise<SupabaseHealthResult> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  const env = {
    urlPresent: !!url && url.trim().length > 0,
    anonKeyPresent: !!anon && anon.trim().length > 0
  };

  if (!env.urlPresent || !env.anonKeyPresent) {
    return {
      env,
      authServiceReachable: false,
      message: 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY'
    };
  }

  const supabase = createClient(url!, anon!);

  // Check auth service availability
  const { data: sessionData, error } = await supabase.auth.getSession();
  if (error) {
    return {
      env,
      authServiceReachable: false,
      message: `Auth check failed: ${error.message}`
    };
  }

  return {
    env,
    authServiceReachable: true,
    message: sessionData?.session ? 'Authenticated session found' : 'No session, but auth is reachable'
  };
}