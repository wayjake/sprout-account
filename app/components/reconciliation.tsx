import { Link } from "react-router";
import type {
  AccountReconciliation,
  ReconcileIssue,
  ReconcileWindow,
} from "~/.server/balances";
import { formatDate } from "~/lib/dates";
import { formatCents, formatCentsAbs } from "~/lib/money";

const SEVERITY_STYLES: Record<ReconcileIssue["severity"], string> = {
  error: "bg-[#ffefef] text-negative",
  warning: "bg-[#fff7dd] text-class-living",
  info: "bg-primary-50 text-primary-800",
};

const SEVERITY_ICON: Record<ReconcileIssue["severity"], string> = {
  error: "⛔",
  warning: "⚠",
  info: "💡",
};

export function IssueList({ issues }: { issues: ReconcileIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1">
      {issues.map((issue, i) => (
        <li
          key={i}
          className={`groove px-2 py-1.5 text-[11px] ${SEVERITY_STYLES[issue.severity]}`}
        >
          <span className="mr-1" aria-hidden>
            {SEVERITY_ICON[issue.severity]}
          </span>
          <span className="font-bold">{issue.message}</span>
          {issue.fix && <span className="ml-1 opacity-80">{issue.fix}</span>}
          {/* Straight to the rows the diagnosis is about — naming a row and
              leaving the user to hunt for it isn't much of a diagnosis. */}
          {issue.link && (
            <Link to={issue.link.to} className="ml-1 font-bold underline">
              {issue.link.label}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function WindowRow({ window }: { window: ReconcileWindow }) {
  if (window.status === "unanchored") {
    return (
      <tr className="text-gray-500">
        <td className="px-3 py-1.5 whitespace-nowrap">
          starting {formatDate(window.toDate)}
        </td>
        <td className="px-3 py-1.5 text-right font-mono tabular-nums">
          {formatCents(window.toCents)}
        </td>
        <td className="px-3 py-1.5 text-right">—</td>
        <td className="px-3 py-1.5 text-right">—</td>
        <td className="px-3 py-1.5 text-[11px] italic">first known balance</td>
      </tr>
    );
  }

  const ok = window.status === "ok";
  // Market movement on a balance-only account is expected, not a problem —
  // it gets neutral styling rather than the red of a real mismatch.
  const movement = window.status === "movement";
  return (
    <tr className={ok || movement ? "" : "bg-[#fff7f7]"}>
      <td className="px-3 py-1.5 whitespace-nowrap">
        {window.fromDate ? `${formatDate(window.fromDate)} → ` : ""}
        {formatDate(window.toDate)}
      </td>
      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
        {formatCents(window.toCents)}
      </td>
      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-gray-600">
        {window.txnCount} · {formatCents(window.txnSumCents)}
      </td>
      <td
        className={`px-3 py-1.5 text-right font-mono tabular-nums ${
          ok ? "text-positive" : movement ? "text-gray-700" : "font-bold text-negative"
        }`}
      >
        {ok ? "✓ 0.00" : formatCents(window.diffCents ?? 0)}
      </td>
      <td className="px-3 py-1.5">
        {ok ? (
          <span className="text-[11px] text-positive">reconciles</span>
        ) : movement ? (
          <span className="text-[11px] text-gray-600">{window.note}</span>
        ) : (
          <span className="text-[11px] font-bold text-negative">
            off by {formatCentsAbs(window.diffCents ?? 0)}
          </span>
        )}
      </td>
    </tr>
  );
}

export function AccountReconcileCard({ recon }: { recon: AccountReconciliation }) {
  const mismatches = recon.windows.filter((w) => w.status === "mismatch");
  const checked = recon.windows.filter((w) => w.status !== "unanchored");
  // A balance-only account is measured against what was paid into it, not
  // against a ledger it doesn't keep.
  const balanceOnly = recon.accountKind === "balance";

  return (
    <div className="groove bg-ledger p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[12px] font-bold text-primary-900">{recon.accountName}</p>
        <span
          className={`px-1.5 text-[10px] font-bold uppercase ${
            recon.status === "mismatch"
              ? "bg-negative text-white"
              : recon.status === "ok" && checked.length > 0
                ? "bg-positive text-white"
                : "bg-gray-300 text-gray-700"
          }`}
        >
          {recon.status === "mismatch"
            ? `${mismatches.length} problem${mismatches.length === 1 ? "" : "s"}`
            : checked.length > 0
              ? balanceOnly
                ? "tracked"
                : "balanced"
              : "no anchor"}
        </span>
      </div>

      {recon.windows.length > 0 && (
        <table className="mb-1.5 w-full text-[11px]">
          <thead>
            <tr className="border-b border-primary-100 text-left text-[10px] font-bold uppercase text-primary-800">
              <th className="px-3 py-1">Period</th>
              <th className="px-3 py-1 text-right">Statement</th>
              <th className="px-3 py-1 text-right">
                {balanceOnly ? "Paid in" : "Activity"}
              </th>
              <th className="px-3 py-1 text-right">Gap</th>
              <th className="px-3 py-1">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-primary-50">
            {recon.windows.map((w, i) => (
              <WindowRow key={i} window={w} />
            ))}
          </tbody>
        </table>
      )}

      <IssueList issues={recon.issues} />
      {mismatches.length > 0 && (
        <div className="mt-1 space-y-1">
          {mismatches.map((w, i) => (
            <IssueList key={i} issues={w.issues} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Reconciliation across several accounts, quiet when everything balances. */
export function ReconcilePanel({
  results,
  emptyMessage = "Nothing to reconcile yet.",
}: {
  results: AccountReconciliation[];
  emptyMessage?: string;
}) {
  // Accounts with neither anchors nor complaints have nothing to say
  const interesting = results.filter(
    (r) => r.windows.length > 0 || r.issues.length > 0,
  );
  if (interesting.length === 0) {
    return <p className="px-1 py-2 text-[11px] italic text-gray-500">{emptyMessage}</p>;
  }
  const problems = interesting.filter((r) => r.status === "mismatch");

  return (
    <div className="space-y-2">
      {problems.length > 0 && (
        <p className="groove bg-[#ffefef] px-2 py-1.5 text-[11px] font-bold text-negative">
          ⛔ {problems.length} account{problems.length === 1 ? "" : "s"} do not
          reconcile — see below for what is likely missing.
        </p>
      )}
      {interesting.map((r) => (
        <AccountReconcileCard key={r.accountId} recon={r} />
      ))}
    </div>
  );
}
