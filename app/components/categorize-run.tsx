import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Button, MessageBar, ProgressBar } from "~/components/ui";

const ENDPOINT = "/api/ai/categorize";

interface RunStats {
  fromMemory: number;
  fromAi: number;
  fromRule: number;
  accountsLinked: number;
  blocked: number;
  lowConfidence: number;
}

type PlanResponse = { ids: number[]; chunkSize: number; queuedBeyondRun: number };
type ChunkResponse = { stats: RunStats; processed: number };
type ErrorResponse = { error: string };
type RunResponse = PlanResponse | ChunkResponse | ErrorResponse;

type Phase =
  | "idle"
  | "planning"
  | "running"
  | "canceling"
  | "canceled"
  | "done"
  | "error";

const ZERO: RunStats = {
  fromMemory: 0,
  fromAi: 0,
  fromRule: 0,
  accountsLinked: 0,
  blocked: 0,
  lowConfidence: 0,
};

/**
 * Drives a bulk categorize run one chunk at a time.
 *
 * A single blocking request for the whole backlog means nothing to look at for
 * a minute and no way out of it. Instead the client asks the server to plan the
 * run, then posts one chunk of ids per fetcher submission: each submission
 * revalidates the page's loaders, so categorized rows appear in the register as
 * they are decided, and the chunk boundary is where a cancel takes effect. The
 * chunk in flight when Cancel is pressed still finishes — its work is already
 * paid for — so "Stopping…" is honest about the wait.
 */
export function useCategorizeRun() {
  const fetcher = useFetcher<RunResponse>();

  // Run bookkeeping lives in refs: the effect below has to read it at response
  // time, when a state value closed over by the render would be stale.
  const queue = useRef<number[]>([]);
  const chunkSize = useRef(40);
  const canceled = useRef(false);
  const handled = useRef<RunResponse | undefined>(undefined);

  const [phase, setPhase] = useState<Phase>("idle");
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [stats, setStats] = useState<RunStats>(ZERO);
  const [queuedBeyondRun, setQueuedBeyondRun] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const submitNextChunk = useCallback(() => {
    const next = queue.current.splice(0, chunkSize.current);
    if (next.length === 0) {
      setPhase("done");
      return;
    }
    fetcher.submit(
      { intent: "run", ids: next.join(",") },
      { method: "post", action: ENDPOINT },
    );
  }, [fetcher]);

  const start = useCallback(() => {
    queue.current = [];
    canceled.current = false;
    // Mark whatever the last run left in `fetcher.data` as already handled: the
    // fetcher keeps its previous response until the new one lands, and a stray
    // re-render must not replay it as if it belonged to this run.
    handled.current = fetcher.data;
    setPhase("planning");
    setTotal(0);
    setDone(0);
    setStats(ZERO);
    setQueuedBeyondRun(0);
    setError(null);
    fetcher.submit({ intent: "plan" }, { method: "post", action: ENDPOINT });
  }, [fetcher]);

  const cancel = useCallback(() => {
    canceled.current = true;
    queue.current = [];
    setPhase("canceling");
  }, []);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const res = fetcher.data;
    // Every response is handled exactly once; re-renders from revalidation
    // hand back the same object.
    if (!res || res === handled.current) return;
    handled.current = res;

    if ("error" in res) {
      setError(res.error);
      setPhase("error");
      return;
    }

    if ("ids" in res) {
      if (canceled.current) {
        setPhase("canceled");
        return;
      }
      queue.current = [...res.ids];
      chunkSize.current = Math.max(1, res.chunkSize);
      setTotal(res.ids.length);
      setQueuedBeyondRun(res.queuedBeyondRun);
      if (res.ids.length === 0) {
        setPhase("done");
        return;
      }
      setPhase("running");
      submitNextChunk();
      return;
    }

    setDone((d) => d + res.processed);
    setStats((prev) => ({
      fromMemory: prev.fromMemory + res.stats.fromMemory,
      fromAi: prev.fromAi + res.stats.fromAi,
      fromRule: prev.fromRule + res.stats.fromRule,
      accountsLinked: prev.accountsLinked + res.stats.accountsLinked,
      blocked: prev.blocked + res.stats.blocked,
      lowConfidence: prev.lowConfidence + res.stats.lowConfidence,
    }));
    if (canceled.current) {
      setPhase("canceled");
      return;
    }
    if (queue.current.length === 0) {
      setPhase("done");
      return;
    }
    submitNextChunk();
  }, [fetcher.state, fetcher.data, submitNextChunk]);

  return {
    phase,
    total,
    done,
    stats,
    queuedBeyondRun,
    error,
    active: phase === "planning" || phase === "running" || phase === "canceling",
    start,
    cancel,
  };
}

export type CategorizeRun = ReturnType<typeof useCategorizeRun>;

/** The start button, or the live progress + Cancel while a run is going. */
export function CategorizeControl({
  run,
  uncategorizedCount,
}: {
  run: CategorizeRun;
  uncategorizedCount: number;
}) {
  if (run.active) {
    return (
      <div className="flex items-center gap-2">
        <ProgressBar
          value={run.done}
          max={run.total}
          label="Categorizing transactions"
          className="w-40"
        />
        <span className="whitespace-nowrap text-[11px] tabular-nums text-gray-700">
          {run.phase === "planning"
            ? "Gathering rows…"
            : `${run.done.toLocaleString()} of ${run.total.toLocaleString()}`}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={run.cancel}
          disabled={run.phase === "canceling"}
        >
          {run.phase === "canceling" ? "Stopping…" : "Cancel"}
        </Button>
      </div>
    );
  }

  if (uncategorizedCount === 0) return null;
  return (
    <Button size="sm" onClick={run.start}>
      🔮 Categorize {uncategorizedCount.toLocaleString()} Uncategorized Transactions
    </Button>
  );
}

/** What the finished (or stopped, or failed) run has to say for itself. */
export function CategorizeStatus({ run }: { run: CategorizeRun }) {
  if (run.phase === "error") {
    return (
      <MessageBar kind="error">
        {run.error}
        {run.done > 0 &&
          ` ${run.done.toLocaleString()} transactions were processed before the error.`}
      </MessageBar>
    );
  }

  if (run.phase !== "done" && run.phase !== "canceled") return null;
  if (run.done === 0) {
    return run.phase === "canceled" ? (
      <MessageBar kind="info">Categorizing stopped before anything ran.</MessageBar>
    ) : (
      <MessageBar kind="info">Nothing left to categorize.</MessageBar>
    );
  }

  const { stats } = run;
  return (
    <MessageBar kind={run.phase === "canceled" ? "info" : "success"}>
      {run.phase === "canceled" &&
        `Stopped after ${run.done.toLocaleString()} of ${run.total.toLocaleString()}. `}
      Categorized {stats.fromMemory.toLocaleString()} transactions from merchant memory
      and {stats.fromAi.toLocaleString()} with AI.
      {stats.fromRule > 0 &&
        ` ${stats.fromRule.toLocaleString()} card payments were matched by rule.`}
      {stats.accountsLinked > 0 &&
        ` ${stats.accountsLinked.toLocaleString()} were linked to a balance-only account as transfers.`}
      {stats.lowConfidence > 0 &&
        ` ${stats.lowConfidence.toLocaleString()} were left uncategorized (low confidence).`}
      {stats.blocked > 0 &&
        ` ${stats.blocked.toLocaleString()} card credits were left uncategorized (income category rejected).`}
      {run.phase === "done" &&
        run.queuedBeyondRun > 0 &&
        ` ${run.queuedBeyondRun.toLocaleString()} still queued — run it again.`}
    </MessageBar>
  );
}
