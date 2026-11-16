// Supabase and Resend setup from environment variables (Deno Edge Functions).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// APP_URL, EMAIL_FROM and RESEND_API_KEY are set with `supabase secrets set`.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ResendConfig } from "./resend.ts";
import type { LogRow } from "./send.ts";

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function serviceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client that carries the caller's JWT, so RLS and RPCs such as has_perm see the caller. */
export function callerClient(authorizationHeader: string): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
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
