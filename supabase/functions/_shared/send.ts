// Sequential, polite batch sending with an email_log row for every attempt.

import { sendViaResend } from "./resend.ts";
import type { ResendConfig, ResendDeps } from "./resend.ts";
import type { PlannedEmail } from "./types.ts";

export interface LogRow {
  session_id: string | null;
  kind: string;
  to_email: string;
  student_id: string | null;
  status: "sent" | "failed" | "skipped";
  error: string | null;
}

export interface SendOptions extends ResendDeps {
  /** Null or undefined when RESEND_API_KEY or EMAIL_FROM is missing: every email is logged as skipped. */
  resend: ResendConfig | null;
  /** Writes one email_log row. Must not throw (the caller wraps database errors). */
  log: (row: LogRow) => Promise<void>;
  /** Pause between sends. Resend's default limit is 2 requests per second. */
  delayMs?: number;
  /** Epoch ms after which no more emails are started. */
  deadlineMs?: number;
  now?: () => number;
  skipReason?: string;
}

export interface SendSummary {
  sent: number;
  failed: number;
  skipped: number;
  /** How many of the emails (a prefix of the list) were attempted. */
  processed: number;
  /** Result of each attempted email, in list order (length = processed). */
  outcomes: ("sent" | "failed" | "skipped")[];
}

export const DEFAULT_DELAY_MS = 600;

export async function sendAll(emails: PlannedEmail[], opts: SendOptions): Promise<SendSummary> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const delay = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sum: SendSummary = { sent: 0, failed: 0, skipped: 0, processed: 0, outcomes: [] };
  let first = true;
  for (const e of emails) {
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) break;
    const base = { session_id: e.sessionId, kind: e.kind, to_email: e.to, student_id: e.studentId };
    if (!opts.resend) {
      await opts.log({ ...base, status: "skipped", error: opts.skipReason ?? "RESEND_API_KEY or EMAIL_FROM not set" });
      sum.skipped++;
      sum.outcomes.push("skipped");
    } else {
      if (!first) await sleep(delay);
      const r = await sendViaResend(opts.resend, e, opts);
      if (r.ok) {
        await opts.log({ ...base, status: "sent", error: null });
        sum.sent++;
        sum.outcomes.push("sent");
      } else {
        await opts.log({ ...base, status: "failed", error: r.error ?? "unknown error" });
        sum.failed++;
        sum.outcomes.push("failed");
      }
      first = false;
    }
    sum.processed++;
  }
  return sum;
}
