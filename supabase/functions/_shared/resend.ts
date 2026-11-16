// Resend HTTP API client. fetch and sleep are injectable for tests.

export interface ResendConfig {
  apiKey: string;
  from: string;
}

export interface ResendMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface ResendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface ResendDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Send one email. Retries once after a 429 (rate limit). Never throws. */
export async function sendViaResend(cfg: ResendConfig, msg: ResendMessage, deps: ResendDeps = {}): Promise<ResendResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      });
      if (res.status === 429 && attempt === 0) {
        const wait = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5) * 1000 : 1500);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, id: body?.id };
      return { ok: false, error: `Resend ${res.status}: ${body?.message ?? body?.error ?? "unknown error"}`.slice(0, 500) };
    } catch (e) {
      return { ok: false, error: `Resend request failed: ${(e as Error).message}`.slice(0, 500) };
    }
  }
  return { ok: false, error: "Resend rate limit" };
}
