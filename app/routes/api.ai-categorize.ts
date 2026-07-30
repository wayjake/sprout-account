import { data } from "react-router";
import { categorizeTransactions } from "~/.server/categorize";
import { AiError } from "~/.server/openrouter";
import type { Route } from "./+types/api.ai-categorize";

/**
 * POST { ids?: "1,2,3" } — categorize specific transactions, or all
 * uncategorized ones when ids is omitted. Memory pass is free; AI is used
 * for the remainder (capped per call).
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const idsRaw = String(form.get("ids") ?? "").trim();
  const ids = idsRaw
    ? idsRaw
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 0)
    : null;

  try {
    const stats = await categorizeTransactions(ids);
    return { stats };
  } catch (err) {
    if (err instanceof AiError) {
      return data({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
