import { data } from "react-router";
import {
  answerBulkQuestion,
  bulkProgress,
  bulkStep,
  retryBulkFile,
  setBulkPaused,
  type BulkAnswer,
} from "~/.server/import/bulk";
import { AiError } from "~/.server/openrouter";
import { isAccountType } from "~/lib/accounts";
import type { Route } from "./+types/api.bulk-step";

/**
 * The bulk run's driver, one step per request.
 *
 * Action-only, and registered outside the shell and settings-pane layouts so a
 * step doesn't drag their loaders along behind it — this endpoint is posted to
 * dozens of times in a row. The run view's own loader still revalidates after
 * each one, which is what puts the progress on the screen.
 *
 * POST intent=step   → one unit of work, then the progress
 * POST intent=answer → apply an answer and unblock the file
 * POST intent=retry  → put a failed file back in the queue for a second read
 * POST intent=pause  → stop the driver between steps (or start it again)
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const sessionId = Number(form.get("sessionId"));
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return data({ error: "Unknown run." }, { status: 400 });
  }
  const intent = String(form.get("intent") ?? "step");

  if (intent === "pause") {
    await setBulkPaused(sessionId, form.get("paused") === "true");
    const progress = await bulkProgress(sessionId);
    return progress ? { progress } : data({ error: "Unknown run." }, { status: 404 });
  }

  if (intent === "answer") {
    const fileId = Number(form.get("fileId"));
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return data({ error: "Unknown file." }, { status: 400 });
    }
    const answer = readAnswer(form);
    if (typeof answer === "string") return data({ error: answer }, { status: 400 });
    const error = await answerBulkQuestion(fileId, answer);
    if (error) return data({ error }, { status: 400 });
    const progress = await bulkProgress(sessionId);
    return progress ? { progress } : data({ error: "Unknown run." }, { status: 404 });
  }

  if (intent === "retry") {
    const fileId = Number(form.get("fileId"));
    if (!Number.isInteger(fileId) || fileId <= 0) {
      return data({ error: "Unknown file." }, { status: 400 });
    }
    const error = await retryBulkFile(fileId);
    if (error) return data({ error }, { status: 400 });
    const progress = await bulkProgress(sessionId);
    return progress ? { progress } : data({ error: "Unknown run." }, { status: 404 });
  }

  if (intent === "step") {
    try {
      const progress = await bulkStep(sessionId);
      if (!progress) return data({ error: "Unknown run." }, { status: 404 });
      return { progress };
    } catch (err) {
      // A step that dies takes the run's momentum with it but not its state —
      // every finished file is already recorded, so Resume carries on.
      if (err instanceof AiError) return data({ error: err.message }, { status: 502 });
      throw err;
    }
  }

  return data({ error: "Unknown intent" }, { status: 400 });
}

/** Read the posted answer, or a message saying why it can't be read. */
function readAnswer(form: FormData): BulkAnswer | string {
  const choice = String(form.get("choice") ?? "");
  if (choice === "skip") return { choice: "skip" };
  if (choice === "account") {
    const accountId = Number(form.get("accountId"));
    if (!Number.isInteger(accountId) || accountId <= 0) return "Pick an account.";
    return { choice: "account", accountId };
  }
  if (choice === "create") {
    const accountType = form.get("accountType");
    if (!isAccountType(accountType)) return "Pick an account type.";
    return {
      choice: "create",
      fields: {
        name: String(form.get("name") ?? ""),
        institution: String(form.get("institution") ?? ""),
        accountType,
        // Only loan types offer a choice; `resolveAccountKind` settles the rest.
        kind: form.get("kind") === "balance" ? "balance" : "transaction",
        lastFour: String(form.get("lastFour") ?? "").trim() || null,
      },
    };
  }
  return "That isn't an answer this run understands.";
}
