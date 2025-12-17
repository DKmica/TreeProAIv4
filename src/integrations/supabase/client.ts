// Supabase client - reads from Vite env, with a safe fallback to your project.
// Import as: import { supabase } from "@/integrations/supabase/client";
import { createClient } from '@supabase/supabase-js';

const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Fallbacks use your project ID and anon key so local dev works if envs aren't set.
const FALLBACK_URL = 'https://mcibncgdkiuqsfwibdtb.supabase.co';
const FALLBACK_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jaWJuY2dla2l1cXNmd2liZHRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI1MTM1MjMsImV4cCI6MjA3ODA4OTUyM30.TDGp4yOAkuqBHoNBYiWXdJu7crRi4cMF0PMP5eu-1Ss';

const SUPABASE_URL = (envUrl && envUrl.trim()) || FALLBACK_URL;
const SUPABASE_ANON_KEY = (envAnon && envAnon.trim()) || FALLBACK_ANON;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);