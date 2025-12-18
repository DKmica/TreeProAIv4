import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
} else {
  console.warn('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable authentication.');
}

export { supabase };
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.warn('Unable to read Supabase session:', error.message);
    return null;
  }
  return data.session?.access_token ?? null;
}

export function onAuthChange(cb: (event: string, session: any) => void) {
  if (!supabase) {
    return { data: null, subscription: { unsubscribe: () => {} } };
  }
  return supabase.auth.onAuthStateChange((event, session) => cb(event, session));
}
