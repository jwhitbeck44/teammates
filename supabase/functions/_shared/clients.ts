// Supabase and Resend setup from environment variables (Deno Edge Functions).
// Supabase provides SUPABASE_URL and the API keys: SUPABASE_SECRET_KEYS and SUPABASE_PUBLISHABLE_KEYS (JSON,
// new style), or the legacy SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY. The new ones are used when
// present (keys.ts). APP_URL, EMAIL_FROM, RESEND_API_KEY and CRON_SECRET are set with `supabase secrets set`.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ResendConfig } from "./resend.ts";
import type { LogRow } from "./send.ts";
import { pickKey } from "./keys.ts";

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** The secret key (bypasses RLS): SUPABASE_SECRET_KEYS["default"], else SUPABASE_SERVICE_ROLE_KEY. */
export function secretKey(): string {
  const k = pickKey(Deno.env.get("SUPABASE_SECRET_KEYS"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!k) throw new Error("Missing environment variable SUPABASE_SECRET_KEYS (or SUPABASE_SERVICE_ROLE_KEY)");
  return k;
}

/** The publishable key (RLS applies): SUPABASE_PUBLISHABLE_KEYS["default"], else SUPABASE_ANON_KEY. */
export function publishableKey(): string {
  const k = pickKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS"), Deno.env.get("SUPABASE_ANON_KEY"));
  if (!k) throw new Error("Missing environment variable SUPABASE_PUBLISHABLE_KEYS (or SUPABASE_ANON_KEY)");
  return k;
}

export function serviceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client that carries the caller's JWT, so RLS and RPCs such as has_perm see the caller. */
export function callerClient(authorizationHeader: string): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), publishableKey(), {
    global: { headers: { Authorization: authorizationHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Null when RESEND_API_KEY or EMAIL_FROM is missing. */
export function resendConfig(): ResendConfig | null {
  const apiKey = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  return apiKey && from ? { apiKey, from } : null;
}

export function skipReason(): string {
  if (!env("RESEND_API_KEY")) return "RESEND_API_KEY not set";
  if (!env("EMAIL_FROM")) return "EMAIL_FROM not set";
  return "email disabled";
}

/** Writes an email_log row; logs to the console instead of throwing when the insert fails. */
export function makeLogger(db: SupabaseClient): (row: LogRow) => Promise<void> {
  return async (row) => {
    const { error } = await db.from("email_log").insert(row);
    if (error) console.error("email_log insert failed", error.message);
  };
}

/** Read every row of a query, 1000 at a time (PostgREST caps a response at 1000 rows by default). */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
