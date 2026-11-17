// Email results for the instructor Status page: counts by kind and status, and the failed sends.
// Pure: rows from the email_log table in, display data out.

import type { EmailLog, EmailStatus } from './types';

/** Plain names for email_log.kind. */
export const EMAIL_KIND_LABELS: Record<string, string> = {
  opened: 'Session opened',
  closing: 'Closing soon',
  published: 'Results published',
  reminder: 'Reminder',
  results_reminder: 'Results reminder',
  reminder_copy: 'Copy to instructor',
};

const KIND_ORDER = ['opened', 'closing', 'published', 'reminder', 'results_reminder', 'reminder_copy'];
export const EMAIL_STATUSES: EmailStatus[] = ['sent', 'failed', 'skipped', 'pending'];

export interface EmailKindCounts {
  kind: string;
  label: string;
  counts: Record<EmailStatus, number>;
}

export interface EmailFailure {
  kind: string;
  label: string;
  to_email: string;
  error: string;
  created_at: string;
  /** A later row for the same student (or address), session and kind was sent or skipped. */
  resolved: boolean;
}

export interface EmailSummary {
  /** One entry per kind that has rows, in a fixed order (unknown kinds last, by name). */
  byKind: EmailKindCounts[];
  /** Failed rows, newest first. */
  failures: EmailFailure[];
  total: number;
}

/** Counts rows (each row is one attempt). A retried email that failed once and was then sent counts once in each. */
export function summarizeEmailLog(rows: readonly EmailLog[]): EmailSummary {
  const byKind = new Map<string, EmailKindCounts>();
  for (const r of rows) {
    let k = byKind.get(r.kind);
    if (!k) {
      k = { kind: r.kind, label: EMAIL_KIND_LABELS[r.kind] ?? r.kind, counts: { sent: 0, failed: 0, skipped: 0, pending: 0 } };
      byKind.set(r.kind, k);
    }
    k.counts[r.status] = (k.counts[r.status] ?? 0) + 1;
  }
  const rank = (kind: string) => {
    const i = KIND_ORDER.indexOf(kind);
    return i === -1 ? KIND_ORDER.length : i;
  };
  const kinds = [...byKind.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const who = (r: EmailLog) => `${r.kind}|${r.student_id ?? r.to_email}`;
  const okAt = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'sent' && r.status !== 'skipped') continue;
    const t = Date.parse(r.created_at);
    okAt.set(who(r), Math.max(okAt.get(who(r)) ?? -Infinity, t));
  }
  const failures = rows
    .filter((r) => r.status === 'failed')
    .map((r) => ({
      kind: r.kind,
      label: EMAIL_KIND_LABELS[r.kind] ?? r.kind,
      to_email: r.to_email,
      error: r.error ?? '',
      created_at: r.created_at,
      resolved: (okAt.get(who(r)) ?? -Infinity) > Date.parse(r.created_at),
    }))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { byKind: kinds, failures, total: rows.length };
}
