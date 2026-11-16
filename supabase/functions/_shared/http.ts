// CORS and JSON helpers shared by the browser-facing functions.

export function appOrigin(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    return new URL(appUrl).origin;
  } catch {
    return null;
  }
}

/** Origins allowed to call from a browser: the GitHub Pages origin from APP_URL, plus localhost for development. */
export function allowedOrigin(requestOrigin: string | null, appUrl: string | undefined): string | null {
  if (!requestOrigin) return null;
  if (requestOrigin === appOrigin(appUrl)) return requestOrigin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) return requestOrigin;
  return null;
}

export function corsHeaders(requestOrigin: string | null, appUrl: string | undefined): Record<string, string> {
  const origin = allowedOrigin(requestOrigin, appUrl) ?? appOrigin(appUrl) ?? "null";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
