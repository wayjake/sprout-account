import { data } from "react-router";
import { desc, isNull, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { AI_BATCH_SIZE, categorizeTransactions } from "~/.server/categorize";
import { AiError } from "~/.server/openrouter";
import type { Route } from "./+types/api.ai-categorize";

/**
 * Most rows one click may enqueue. The run is chunked and cancelable, so this
 * is a guard against a stray click on a 12,000-row backlog turning into 300 AI
 * calls, not a per-request cost ceiling — what is left over is reported back so
 * the user can run it again.
 */
const RUN_LIMIT = 1000;

/**
 * The bulk categorize run, driven a chunk at a time from the client so rows
 * land in the register as they are decided rather than all at the end, and so
 * the run can be stopped between chunks.
 *
 * POST intent=plan          → { ids, chunkSize, queuedBeyondRun }
 * POST intent=run ids=1,2,3 → { stats, processed }
 *
 * The client owns the id list for the whole run: the AI deliberately leaves
 * low-confidence and guard-blocked rows uncategorized, so a server-side
 * "next 40 uncategorized" loop would hand back the same rows forever.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "plan");

  if (intent === "plan") {
    const t = schema.transactions;
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(t)
      .where(isNull(t.categoryId));
    // Newest first: a run that gets canceled halfway should have spent its
    // calls on the transactions the user is most likely looking at.
    const rows = await db
      .select({ id: t.id })
      .from(t)
      .where(isNull(t.categoryId))
      .orderBy(desc(t.date), desc(t.id))
      .limit(RUN_LIMIT);
    return {
      ids: rows.map((r) => r.id),
      chunkSize: AI_BATCH_SIZE,
      queuedBeyondRun: Math.max(0, count - rows.length),
    };
  }

  if (intent === "run") {
    const idsRaw = String(form.get("ids") ?? "").trim();
    const ids = idsRaw
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return data({ error: "No transactions given" }, { status: 400 });

    try {
      const stats = await categorizeTransactions(ids);
      return { stats, processed: ids.length };
    } catch (err) {
      if (err instanceof AiError) {
        return data({ error: err.message }, { status: 502 });
      }
      throw err;
    }
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}
