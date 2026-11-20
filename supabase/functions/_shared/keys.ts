// API keys from the Edge Function environment. Pure: takes the raw variable values, so it is unit tested
// without Deno.env.
//
// Supabase retires the legacy anon and service_role keys by the end of 2026. Edge Functions then get
// SUPABASE_PUBLISHABLE_KEYS and SUPABASE_SECRET_KEYS: JSON objects keyed by key name, where the first key
// created is named "default" (docs: getting-started/migrating-to-new-api-keys, step 4). The legacy
// SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are plain strings and are used only when the new
// variable is missing, not valid JSON, or has no usable key.

export const DEFAULT_KEY_NAME = "default";

/** The key named "default" in a JSON object of keys, else the first string value; null when there is none. */
export function keyFromJson(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const usable = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  if (usable(obj[DEFAULT_KEY_NAME])) return (obj[DEFAULT_KEY_NAME] as string).trim();
  for (const v of Object.values(obj)) if (usable(v)) return v.trim();
  return null;
}

/** New-style key first, legacy key second. */
export function pickKey(newJson: string | undefined, legacy: string | undefined): string | null {
  const fromNew = keyFromJson(newJson);
  if (fromNew) return fromNew;
  return legacy !== undefined && legacy.trim() !== "" ? legacy.trim() : null;
}
