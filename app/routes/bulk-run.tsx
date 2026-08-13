import { useCallback, useEffect, useRef, useState } from "react";
import { Link, data, redirect, useFetcher, useNavigation } from "react-router";
import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { reconcileAccounts } from "~/.server/balances";
import {
  bulkFilesFor,
  bulkProgress,
  discardBulkRun,
  parseQuestion,
  type BulkProgress,
  type BulkQuestion,
} from "~/.server/import/bulk";
import { pendingRowsForBatches } from "~/.server/import/stage";
import { ReconcilePanel } from "~/components/reconciliation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  MessageBar,
  ProgressBar,
  inputClass,
  selectClass,
} from "~/components/ui";
import { ACCOUNT_TYPE_LABELS } from "~/lib/accounts";
import { ACCOUNT_TYPES, type BulkFileStatus } from "~/db/schema";
import type { Route } from "./+types/bulk-run";

export function meta() {
  return [{ title: "Bulk Import Run · Sprout Account — Household Ledger" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const sessionId = Number(params.sessionId);
  const session = await db.query.importSessions.findFirst({
    where: eq(schema.importSessions.id, sessionId),
  });
  if (!session) throw data("Run not found", { status: 404 });
  if (session.purpose !== "bulk") {
    throw redirect(
      session.purpose === "reconcile"
        ? `/reconcile/${sessionId}`
        : `/import/session/${sessionId}`,
    );
  }

  const [progress, files, accounts] = await Promise.all([
    bulkProgress(sessionId),
    bulkFilesFor(sessionId),
    db.select().from(schema.accounts).orderBy(schema.accounts.sortOrder, schema.accounts.name),
  ]);
  const accountName = new Map(accounts.map((a) => [a.id, `${a.name} (${a.institution})`]));
  const shouldReconcile =
    progress?.phase === "commit" ||
    progress?.phase === "categorize" ||
    progress?.phase === "done";
  const touchedAccounts = shouldReconcile
    ? [
        ...new Set(
          files.map((f) => f.accountId).filter((id): id is number => id != null),
        ),
      ]
    : [];
  const pendingBatchIds = shouldReconcile
    ? files
        .filter((f) => f.status === "staged" || f.status === "held")
        .map((f) => f.batchId)
        .filter((id): id is number => id != null)
    : [];
  const pending = await pendingRowsForBatches(pendingBatchIds);
  const reconciliation =
    touchedAccounts.length > 0 ? await reconcileAccounts(pending, touchedAccounts) : [];

  return {
    sessionId,
    sessionStatus: session.status,
    skipped: (session.notesJson ? JSON.parse(session.notesJson) : []) as {
      filename: string;
      error: string;
    }[],
    progress,
    reconciliation,
    files: files.map((f) => ({
      id: f.id,
      filename: f.filename,
      relPath: f.relPath,
      status: f.status,
      note: f.note,
      batchId: f.batchId,
      accountAssignment: f.accountAssignment,
      accountName: f.accountId ? (accountName.get(f.accountId) ?? null) : null,
      question: parseQuestion(f.questionJson),
    })),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const sessionId = Number(params.sessionId);
  const form = await request.formData();
  if (form.get("intent") === "discard") {
    await discardBulkRun(sessionId);
    return redirect("/import/bulk");
  }
  return data({ error: "Unknown intent" }, { status: 400 });
}

const STATUS_LABELS: Record<BulkFileStatus, string> = {
  queued: "waiting",
  identified: "reading",
  staged: "staged",
  committed: "imported",
  categorized: "done",
  needs_input: "needs you",
  held: "held",
  skipped: "skipped",
  failed: "failed",
};

const STATUS_STYLES: Record<BulkFileStatus, string> = {
  queued: "bg-gray-300 text-gray-700",
  identified: "bg-primary-200 text-primary-900",
  staged: "bg-primary-400 text-white",
  committed: "bg-primary-600 text-white",
  categorized: "bg-positive text-white",
  needs_input: "bg-class-living text-white",
  held: "bg-class-luxury text-white",
  skipped: "bg-gray-300 text-gray-600",
  failed: "bg-negative text-white",
};

type StepResponse = { progress: BulkProgress } | { error: string };

/**
 * Drives the run a step at a time from the browser.
 *
 * The same shape as `useCategorizeRun`, and for the same reasons: one long
 * request would show nothing for an hour and offer no way out of it, whereas a
 * step per submission puts each statement on the screen as it lands (every
 * submission revalidates this route's loader) and gives a pause somewhere to
 * take effect. The honest limit is that the browser is the thing doing the
 * driving — close the tab and the run stops where it is. Nothing is lost,
 * because every step wrote what it did to the database before returning, and
 * Resume picks the run back up.
 */
function useBulkRunner(sessionId: number, progress: BulkProgress | null) {
  const fetcher = useFetcher<StepResponse>();
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // A pause the user asked for, remembered locally until the loader catches up.
  // `progress` goes on describing a running run for the render or two between
  // the click and the revalidation, and the auto-start effect below reads that
  // as a run that needs starting — restarting the very run just paused, on the
  // same fetcher, which supersedes the pause request into the bargain.
  const [pauseRequested, setPauseRequested] = useState(false);
  const handled = useRef<StepResponse | undefined>(undefined);

  const step = useCallback(() => {
    fetcher.submit(
      { intent: "step", sessionId: String(sessionId) },
      { method: "post", action: "/api/bulk/step" },
    );
  }, [fetcher, sessionId]);

  const start = useCallback(() => {
    setError(null);
    handled.current = fetcher.data;
    setRunning(true);
    step();
  }, [fetcher.data, step]);

  const stop = useCallback(() => {
    setRunning(false);
    setPauseRequested(true);
    fetcher.submit(
      { intent: "pause", paused: "true", sessionId: String(sessionId) },
      { method: "post", action: "/api/bulk/step" },
    );
  }, [fetcher, sessionId]);

  // Each response is acted on exactly once — revalidation re-renders with the
  // same object, and stepping again on it would double the run's pace.
  useEffect(() => {
    if (fetcher.state !== "idle" || !running) return;
    const res = fetcher.data;
    if (!res || res === handled.current) return;
    handled.current = res;

    if ("error" in res) {
      setError(res.error);
      setRunning(false);
      return;
    }
    const p = res.progress;
    if (p.done || p.paused || p.waiting) {
      setRunning(false);
      return;
    }
    step();
  }, [fetcher.state, fetcher.data, running, step]);

  // Arriving from the upload — or coming back to a run left half-done — starts
  // it going, and answering the last outstanding question starts it again. A
  // finished, paused or errored run stays put, and so does one still waiting on
  // an answer: `progress` comes from the loader, which revalidates after every
  // step and every answer, so this reacts to the run's real state rather than
  // to having been mounted.
  useEffect(() => {
    if (!progress || running || error || pauseRequested) return;
    if (progress.done || progress.paused || progress.waiting) return;
    start();
  }, [progress, running, error, pauseRequested, start]);

  const resume = useCallback(() => {
    setError(null);
    setPauseRequested(false);
    handled.current = fetcher.data;
    setRunning(true);
    fetcher.submit(
      { intent: "pause", paused: "false", sessionId: String(sessionId) },
      { method: "post", action: "/api/bulk/step" },
    );
  }, [fetcher, sessionId]);

  return { running, error, start, stop, resume, busy: fetcher.state !== "idle" };
}

export default function BulkRun({ loaderData }: Route.ComponentProps) {
  const { sessionId, progress, files, skipped, reconciliation } = loaderData;
  const runner = useBulkRunner(sessionId, progress);
  const answerer = useFetcher<{ error?: string }>();
  const discarder = useFetcher<{ error?: string }>();
  const navigation = useNavigation();

  // Both of these are slow — a discard walks every batch (a network round trip
  // per write under Turso), and the close screen's loader reconciles every
  // staged batch before it can render. Left looking idle, a second click is
  // the natural response, so each one gets a disabled control and the whole
  // window gets the hourglass below.
  const discarding = discarder.state !== "idle";
  const reviewing =
    navigation.state !== "idle" &&
    navigation.location?.pathname === `/reconcile/${sessionId}`;

  const questions = files.filter((f) => f.question);
  const held = files.filter((f) => f.status === "held");
  const counts = progress?.counts;
  const finished = counts
    ? counts.categorized + counts.committed + counts.skipped + counts.failed + counts.held
    : 0;

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-[16px] font-bold text-primary-950">
            📚 Bulk import run <Badge title="Still finding its feet">Beta</Badge>
          </h1>
          <p className="text-[12px] text-gray-600">
            {progress?.done
              ? "This run has finished."
              : runner.running
                ? "Working through the folder — you can leave this page, but the run pauses when you do."
                : "Paused. Nothing is lost; Resume carries on from the next statement."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!progress?.done &&
            (runner.running ? (
              <Button size="sm" variant="secondary" onClick={runner.stop}>
                Pause
              </Button>
            ) : (
              <Button size="sm" onClick={runner.resume} disabled={runner.busy}>
                Resume
              </Button>
            ))}
          <discarder.Form method="post">
            <input type="hidden" name="intent" value="discard" />
            <Button size="sm" variant="ghost" type="submit" disabled={discarding}>
              {discarding ? "Discarding…" : "Discard run"}
            </Button>
          </discarder.Form>
        </div>
      </div>

      {/* The system is busy, vintage style: an invisible sheet over the whole
          window that turns the pointer into the hourglass and swallows every
          click until the slow thing finishes. */}
      {(discarding || reviewing) && (
        <div className="fixed inset-0 z-50 cursor-wait" aria-hidden="true" />
      )}

      {runner.error && <MessageBar kind="error">{runner.error}</MessageBar>}
      {answerer.data?.error && <MessageBar kind="error">{answerer.data.error}</MessageBar>}
      {discarder.data?.error && <MessageBar kind="error">{discarder.data.error}</MessageBar>}

      {progress && (
        <Card>
          <CardHeader title={`Progress — ${PHASE_LABELS[progress.phase]}`} />
          <div className="space-y-2 bg-ledger p-3">
            <div className="flex items-center gap-3">
              <ProgressBar
                value={finished}
                max={progress.total || 1}
                label="Statements processed"
                className="flex-1"
              />
              <span className="whitespace-nowrap text-[11px] tabular-nums text-gray-700">
                {finished} of {progress.total}
              </span>
            </div>
            {progress.categorize.total > 0 && (
              <div className="flex items-center gap-3">
                <ProgressBar
                  value={progress.categorize.done}
                  max={progress.categorize.total}
                  label="Transactions categorized"
                  className="flex-1"
                />
                <span className="whitespace-nowrap text-[11px] tabular-nums text-gray-700">
                  {progress.categorize.done} of {progress.categorize.total} categorized
                </span>
              </div>
            )}
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-700">
              <Stat label="Rows added" value={progress.stats.inserted} />
              <Stat label="Balances recorded" value={progress.stats.balancesRecorded} />
              <Stat label="Accounts created" value={progress.stats.accountsCreated} />
              <Stat label="Transfers linked" value={progress.stats.transfersLinked} />
              <Stat label="Categorized" value={progress.stats.categorized} />
            </dl>
          </div>
        </Card>
      )}

      {questions.length > 0 && (
        <Card>
          <CardHeader title={`❓ Waiting on you (${questions.length})`} />
          <div className="space-y-2 bg-ledger p-3">
            <p className="text-[11px] text-gray-600">
              The run stops here rather than guessing — a statement filed against the
              wrong account is harder to undo than to answer.
            </p>
            {questions.map((f) => (
              <QuestionCard
                key={f.id}
                sessionId={sessionId}
                fileId={f.id}
                filename={f.relPath ?? f.filename}
                question={f.question!}
                fetcher={answerer}
              />
            ))}
          </div>
        </Card>
      )}

      {held.length > 0 && (
        <Card>
          <CardHeader title={`🔍 Held for review (${held.length})`} />
          <div className="bg-ledger p-3">
            <p className="groove mb-2 bg-[#fff7dd] px-2 py-1 text-[11px] text-class-living">
              These were read and staged but not committed — either you asked to commit
              by hand, or the statement disagrees with something it can be checked
              against, and a wrong row is worse than a late one.{" "}
              {reviewing ? (
                <span aria-disabled="true" className="font-bold text-gray-500">
                  Opening the close screen…
                </span>
              ) : (
                <Link
                  to={`/reconcile/${sessionId}`}
                  className="font-bold text-primary-700 hover:underline"
                >
                  Review them on the close screen →
                </Link>
              )}
            </p>
            <ul className="space-y-1">
              {held.map((f) => (
                <li key={f.id} className="text-[11px] text-gray-700">
                  <span className="font-bold">{f.filename}</span>
                  {f.note && <span className="text-gray-500"> — {f.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      {progress && progress.phase !== "scan" && progress.phase !== "dedupe" && (
        <Card>
          <CardHeader title="⚖️ Account check" />
          <div className="bg-ledger p-3">
            <p className="mb-2 text-[11px] text-gray-600">
              Statement balances are checked against all activity in this run. Any gap
              shown here must be reviewed before the affected account can be trusted.
            </p>
            <ReconcilePanel
              results={reconciliation}
              emptyMessage="No account balances are available to check yet."
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title={`📄 Statements (${files.length})`} />
        {files.length === 0 ? (
          <div className="bg-ledger">
            <EmptyState title="No statements in this run" />
          </div>
        ) : (
          <ul className="ledger-stripes divide-y divide-primary-50 bg-ledger">
            {files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
                <span
                  className={`w-20 shrink-0 px-1.5 text-center text-[10px] font-bold uppercase ${STATUS_STYLES[f.status]}`}
                >
                  {STATUS_LABELS[f.status]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-bold text-gray-800">
                    {f.relPath ?? f.filename}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500">
                    {f.note ?? f.accountAssignment ?? "—"}
                  </span>
                </span>
                {f.status === "failed" && (
                  <answerer.Form method="post" action="/api/bulk/step" className="shrink-0">
                    <input type="hidden" name="intent" value="retry" />
                    <input type="hidden" name="sessionId" value={sessionId} />
                    <input type="hidden" name="fileId" value={f.id} />
                    <Button
                      size="sm"
                      variant="secondary"
                      type="submit"
                      disabled={answerer.state !== "idle"}
                    >
                      Try again
                    </Button>
                  </answerer.Form>
                )}
                <span className="w-44 shrink-0 truncate text-[11px] text-gray-700">
                  {f.accountName ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {skipped.length > 0 && (
        <Card>
          <CardHeader title={`Skipped — not statements (${skipped.length})`} />
          <ul className="bg-ledger p-3 text-[11px] text-gray-600">
            {skipped.map((s) => (
              <li key={s.filename}>{s.filename}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<BulkProgress["phase"], string> = {
  scan: "reading statements",
  dedupe: "settling overlaps",
  commit: "writing to the ledger",
  categorize: "categorizing",
  done: "finished",
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex gap-1">
      <dt className="font-bold text-gray-800">{label}:</dt>
      <dd className="tabular-nums">{value.toLocaleString()}</dd>
    </span>
  );
}

function QuestionCard({
  sessionId,
  fileId,
  filename,
  question,
  fetcher,
}: {
  sessionId: number;
  fileId: number;
  filename: string;
  question: BulkQuestion;
  fetcher: ReturnType<typeof useFetcher<{ error?: string }>>;
}) {
  const busy = fetcher.state !== "idle";
  const hidden = (
    <>
      <input type="hidden" name="intent" value="answer" />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="fileId" value={fileId} />
    </>
  );
  const post = { method: "post" as const, action: "/api/bulk/step" };

  return (
    <div className="groove bg-[#fff7dd] p-2 text-[11px]">
      <p className="font-bold text-gray-800">{filename}</p>
      <p className="text-gray-700">{question.prompt}</p>

      {question.options.length > 0 && (
        <fetcher.Form {...post} className="mt-1.5 flex items-end gap-2">
          {hidden}
          <input type="hidden" name="choice" value="account" />
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-bold uppercase text-primary-800">
              Use an existing account
            </span>
            <select name="accountId" className={`${selectClass} py-[1px] text-[11px]`}>
              {question.options.map((o) => (
                <option key={o.accountId} value={o.accountId}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="secondary" type="submit" disabled={busy}>
            Use this
          </Button>
        </fetcher.Form>
      )}

      <fetcher.Form {...post} className="mt-1.5 flex flex-wrap items-end gap-2">
        {hidden}
        <input type="hidden" name="choice" value="create" />
        <input type="hidden" name="kind" value={question.proposal.kind} />
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase text-primary-800">Name</span>
          <input
            name="name"
            required
            defaultValue={question.proposal.name}
            className={`${inputClass} w-36 py-[1px] text-[11px]`}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase text-primary-800">
            Institution
          </span>
          <input
            name="institution"
            required
            defaultValue={question.proposal.institution}
            className={`${inputClass} w-32 py-[1px] text-[11px]`}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase text-primary-800">Type</span>
          <select
            name="accountType"
            defaultValue={question.proposal.accountType}
            className={`${selectClass} py-[1px] text-[11px]`}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase text-primary-800">
            Last four
          </span>
          <input
            name="lastFour"
            inputMode="numeric"
            maxLength={4}
            defaultValue={question.proposal.lastFour ?? ""}
            className={`${inputClass} w-16 py-[1px] text-[11px]`}
          />
        </label>
        <Button size="sm" type="submit" disabled={busy}>
          Create it
        </Button>
      </fetcher.Form>

      <fetcher.Form {...post} className="mt-1.5">
        {hidden}
        <input type="hidden" name="choice" value="skip" />
        <Button size="sm" variant="ghost" type="submit" disabled={busy}>
          Skip this statement
        </Button>
      </fetcher.Form>
    </div>
  );
}
