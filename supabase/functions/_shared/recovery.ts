// Delivery step of the "email me my links" function. The slot is claimed (a pending email_log row is
// written) BEFORE anything is sent, so parallel requests cannot exceed the limits; the row is then
// updated to sent, failed or skipped. The limits themselves are enforced by claim_recovery_slot() in SQL.

import { sendAll } from "./send.ts";
import type { SendOptions } from "./send.ts";
import type { PlannedEmail } from "./types.ts";

export type RecoveryOutcome = "limited" | "sent" | "failed" | "skipped";

export interface RecoveryDeliveryDeps extends Omit<SendOptions, "log"> {
  /** Reserves a slot and returns the id of the pending row, or null when a limit is reached. */
  claim: () => Promise<string | null>;
  /** Sets the final status of the pending row. */
  finish: (id: string, status: "sent" | "failed" | "skipped", error: string | null) => Promise<void>;
}

export async function deliverRecovery(email: PlannedEmail, deps: RecoveryDeliveryDeps): Promise<RecoveryOutcome> {
  const id = await deps.claim();
  if (id === null) return "limited";
  let outcome: RecoveryOutcome = "failed";
  try {
    await sendAll([email], {
      ...deps,
      log: async (row) => {
        outcome = row.status;
        await deps.finish(id, row.status, row.error);
      },
    });
  } catch (e) {
    await deps.finish(id, "failed", (e as Error).message.slice(0, 300));
  }
  return outcome;
}
