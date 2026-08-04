import { Form, Link } from "react-router";
import {
  balanceTrends,
  incomeByMonth,
  spendByMonthAndClass,
  topCategories,
} from "~/.server/queries";
import {
  CHART_CLASS_COLORS,
  SpendStackChart,
  TrendLineChart,
  type MonthSpend,
} from "~/components/charts";
import { Card, CardHeader, ClassBadge, EmptyState, selectClass } from "~/components/ui";
import { addMonths, formatMonth, monthEnd, monthOf, monthRange, monthStart, todayISO } from "~/lib/dates";
import { formatCentsAbs } from "~/lib/money";
import type { Route } from "./+types/dashboard";

export function meta() {
  return [{ title: "Dashboard · Sprout Account — Household Ledger" }];
}

const RANGE_OPTIONS = [3, 6, 12, 24] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const monthsBack = RANGE_OPTIONS.includes(Number(url.searchParams.get("months")) as 3)
    ? Number(url.searchParams.get("months"))
    : 6;

  const currentMonth = monthOf(todayISO());
  const startMonth = addMonths(currentMonth, -(monthsBack - 1));
  const fromDate = monthStart(startMonth);
  const toDate = monthEnd(currentMonth);

  const [spend, income, top, trends] = await Promise.all([
    spendByMonthAndClass(fromDate, toDate),
    incomeByMonth(fromDate, toDate),
    topCategories(fromDate, toDate),
    balanceTrends(),
  ]);

  const months = monthRange(startMonth, currentMonth);
  const byMonth = new Map<string, MonthSpend>(
    months.map((m) => [
      m,
      { month: m, base: 0, living: 0, luxury: 0, uncategorized: 0, income: 0 },
    ]),
  );
  for (const row of spend) {
    const m = byMonth.get(row.month);
    if (!m) continue;
    const slice = row.spendingClass ?? "uncategorized";
    if (slice === "base" || slice === "living" || slice === "luxury" || slice === "uncategorized") {
      m[slice] += Math.abs(row.totalCents);
    }
  }
  for (const row of income) {
    const m = byMonth.get(row.month);
    if (m) m.income += row.totalCents;
  }
  const chartData = [...byMonth.values()];

  const current = byMonth.get(currentMonth)!;
  const currentSpend =
    current.base + current.living + current.luxury + current.uncategorized;

  return {
    monthsBack,
    chartData,
    top,
    trends,
    currentMonth,
    summary: {
      spend: currentSpend,
      income: current.income,
      net: current.income - currentSpend,
      base: current.base,
      living: current.living,
      luxury: current.luxury,
    },
  };
}

/**
 * Chevron-ribbon step in the accounting workflow ribbon. The steps sit in a
 * grid, so every one is the same width and height — the padding leaves room for
 * the notch the clip path bites out of each side.
 */
function WorkflowStep({
  to,
  icon,
  title,
  blurb,
}: {
  to: string;
  icon: string;
  title: string;
  blurb: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-[60px] items-center gap-3 bg-primary-100 py-2.5 pl-[26px] pr-6 hover:bg-primary-200"
      style={{
        clipPath:
          "polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)",
      }}
    >
      <span className="w-5 shrink-0 text-center text-lg leading-none" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-bold leading-tight text-primary-900">
          {title}
        </span>
        <span className="mt-[2px] block text-[10px] leading-tight text-gray-600">
          {blurb}
        </span>
      </span>
    </Link>
  );
}

/** Glorious LCD readout, straight off a '99 desk calculator. */
function LcdTile({
  label,
  value,
  color = "#5cff8a",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="bevel-out flex h-full flex-col p-[3px]">
      <p className="px-1 pb-[3px] text-[10px] font-bold uppercase leading-[1.2] tracking-wide text-gray-700">
        {label}
      </p>
      {/* mt-auto: readouts line up across the row even when a label wraps */}
      <div className="bevel-in mt-auto bg-[#101810] px-2 py-1.5 text-right">
        <span
          className="block truncate font-mono text-[15px] font-bold tabular-nums"
          style={{ color, textShadow: `0 0 6px ${color}55` }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { monthsBack, chartData, top, trends, currentMonth, summary } = loaderData;
  const hasAnySpend = chartData.some(
    (m) => m.base + m.living + m.luxury + m.uncategorized + m.income > 0,
  );
  const maxTop = Math.max(...top.map((t) => Math.abs(t.totalCents)), 1);

  return (
    <div className="space-y-4">
      {/* Accounting workflow ribbon */}
      <Card>
        <CardHeader title="🗺️ Accounting Workflow" />
        <div className="grid gap-[3px] bg-ledger p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          <WorkflowStep
            to="/import"
            icon="📥"
            title="Import Statements"
            blurb="Bring in new statements"
          />
          <WorkflowStep
            to="/transactions?category=none"
            icon="🏷️"
            title="Categorize Transactions"
            blurb="Clear the uncategorized"
          />
          <WorkflowStep
            to="/balances"
            icon="🏦"
            title="Review Balances"
            blurb="Check every account"
          />
          <WorkflowStep
            to="/transfers"
            icon="⛴️"
            title="Match Transfers"
            blurb="Pair money moved between accounts"
          />
          <WorkflowStep
            to="/amazon"
            icon="📦"
            title="Match Amazon Orders"
            blurb="Tie orders to card charges"
          />
          <WorkflowStep
            to="/transactions"
            icon="📒"
            title="Review Transactions"
            blurb="Inspect every entry"
          />
          <WorkflowStep
            to="/backups"
            icon="💾"
            title="Back Up Data"
            blurb="Save a snapshot"
          />
        </div>
      </Card>

      {/* This month's summary */}
      <Card>
        <CardHeader title={`📜 ${formatMonth(currentMonth)} Summary`}>
          <Form method="get">
            <select
              name="months"
              defaultValue={monthsBack}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              className={`${selectClass} py-0 text-[11px] leading-tight`}
            >
              {RANGE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Last {n} months
                </option>
              ))}
            </select>
          </Form>
        </CardHeader>
        <div className="grid grid-cols-2 gap-2 bg-ledger p-3 sm:grid-cols-3 2xl:grid-cols-6">
          <LcdTile label="Expenses" value={formatCentsAbs(summary.spend)} color="#ffd24a" />
          <LcdTile label="Income" value={formatCentsAbs(summary.income)} />
          <LcdTile
            label="Net cash flow"
            value={`${summary.net < 0 ? "−" : "+"}${formatCentsAbs(summary.net)}`}
            color={summary.net < 0 ? "#ff6a5c" : "#5cff8a"}
          />
          <LcdTile label="Fixed expenses" value={formatCentsAbs(summary.base)} />
          <LcdTile
            label="Essential expenses"
            value={formatCentsAbs(summary.living)}
            color="#ffd24a"
          />
          <LcdTile
            label="Discretionary expenses"
            value={formatCentsAbs(summary.luxury)}
            color="#ff9a5c"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="📊 Spending by class, month by month" />
        <div className="bg-ledger p-3">
          {hasAnySpend ? (
            <SpendStackChart data={chartData} />
          ) : (
            <EmptyState
              title="Nothing to chart yet"
              detail="Import some transactions and categorize a few to see spending by month."
            >
              <Link to="/import" className="bevel-btn px-3 py-1 text-[11px] font-bold">
                📥 Import statements
              </Link>
            </EmptyState>
          )}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="🏆 Top spending categories" />
          {top.length === 0 ? (
            <div className="bg-ledger p-3">
              <EmptyState title="No spending recorded yet" />
            </div>
          ) : (
            <ul className="space-y-2 bg-ledger p-3">
              {top.map((t) => (
                <li key={t.name}>
                  <div className="mb-[2px] flex items-center justify-between text-[12px]">
                    <span className="flex items-center gap-2 font-bold text-gray-800">
                      {t.name}
                      {t.spendingClass && <ClassBadge spendingClass={t.spendingClass} />}
                    </span>
                    <span className="font-mono tabular-nums text-gray-700">
                      {formatCentsAbs(t.totalCents)}
                    </span>
                  </div>
                  <div className="bevel-in h-[14px] bg-white p-[2px]">
                    <div
                      className="h-full"
                      style={{
                        width: `${(Math.abs(t.totalCents) / maxTop) * 100}%`,
                        background: `repeating-linear-gradient(90deg, ${
                          t.spendingClass
                            ? CHART_CLASS_COLORS[t.spendingClass as "base" | "living" | "luxury"]
                            : CHART_CLASS_COLORS.uncategorized
                        } 0 6px, transparent 6px 8px)`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="💎 Savings goals over time" />
          <div className="bg-ledger p-3">
            {trends.length === 0 ? (
              <EmptyState
                title="No balances charted yet"
                detail="Set a balance on the Account Balances page, or close a month on Monthly Reconcile."
              />
            ) : (
              <TrendLineChart
                series={trends.map((t) => ({ name: t.accountName, points: t.points }))}
              />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
