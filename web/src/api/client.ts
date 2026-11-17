import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
/**
 * The project's publishable key (sb_publishable_...). VITE_SUPABASE_PUBLISHABLE_KEY is read first; the older
 * name VITE_SUPABASE_ANON_KEY still works and may hold either the publishable key or the legacy anon key.
 * Supabase retires the legacy anon key by the end of 2026 (DEPLOY.md step 2).
 */
export const publicApiKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const anonKey = publicApiKey;

export const isConfigured = url !== '' && anonKey !== '';

// Placeholder values keep the app loadable (and buildable) without a .env file.
// PKCE so the password reset link carries `?code=` in the query string. The default (implicit) flow puts tokens in
// the URL hash, which HashRouter would treat as a route.
export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'missing-anon-key', {
  auth: { flowType: 'pkce' },
});
