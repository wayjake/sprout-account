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
  return [{ title: "Adventure Map · Sprout Account 2000" }];
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

/** Chevron-ribbon quest step for the adventure map. */
function QuestStep({
  to,
  icon,
  title,
  blurb,
  first = false,
}: {
  to: string;
  icon: string;
  title: string;
  blurb: string;
  first?: boolean;
}) {
  return (
    <Link
      to={to}
      className="group relative flex min-w-36 flex-1 items-center gap-2 bg-primary-100 px-5 py-2.5 hover:bg-primary-200"
      style={{
        clipPath: first
          ? "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%)"
          : "polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%)",
      }}
    >
      <span className="text-xl" aria-hidden>
        {icon}
      </span>
      <span>
        <span className="block text-[11px] font-bold text-primary-900">{title}</span>
        <span className="block text-[10px] leading-tight text-gray-600">{blurb}</span>
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
    <div className="bevel-out p-[3px]">
      <p className="px-1 pb-[2px] text-[10px] font-bold uppercase tracking-wide text-gray-700">
        {label}
      </p>
      <div className="bevel-in bg-[#101810] px-2 py-1.5 text-right">
        <span
          className="font-mono text-[16px] font-bold tabular-nums"
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
      {/* Adventure map quest line */}
      <Card>
        <CardHeader title="🗺️ Your Accounting Adventure — choose your quest" />
        <div className="flex flex-wrap gap-[2px] bg-ledger p-3">
          <QuestStep
            first
            to="/import"
            icon="📥"
            title="The Receiving Dock"
            blurb="Haul in fresh statements"
          />
          <QuestStep
            to="/transactions?category=none"
            icon="🏷️"
            title="The Sorting Room"
            blurb="Tame unsorted coins"
          />
          <QuestStep
            to="/balances"
            icon="🏦"
            title="The Counting House"
            blurb="Weigh every purse"
          />
          <QuestStep
            to="/transfers"
            icon="⛴️"
            title="The Ferry Docks"
            blurb="Pair gold moved between purses"
          />
          <QuestStep
            to="/amazon"
            icon="📦"
            title="The Endless Bazaar"
            blurb="Match mystery parcels"
          />
          <QuestStep
            to="/transactions"
            icon="📒"
            title="The Great Ledger"
            blurb="Inspect every entry"
          />
          <QuestStep
            to="/backups"
            icon="💾"
            title="The Time Vault"
            blurb="Preserve your saga"
          />
        </div>
      </Card>

      {/* This month's tale */}
      <Card>
        <CardHeader title={`📜 The Tale of ${formatMonth(currentMonth)}`}>
          <Form method="get">
            <select
              name="months"
              defaultValue={monthsBack}
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              className={`${selectClass} py-[1px] text-[11px]`}
            >
              {RANGE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  Last {n} months
                </option>
              ))}
            </select>
          </Form>
        </CardHeader>
        <div className="grid grid-cols-2 gap-2 bg-ledger p-3 md:grid-cols-6">
          <LcdTile label="Gold spent" value={formatCentsAbs(summary.spend)} color="#ffd24a" />
          <LcdTile label="Gold earned" value={formatCentsAbs(summary.income)} />
          <LcdTile
            label="Net haul"
            value={`${summary.net < 0 ? "−" : "+"}${formatCentsAbs(summary.net)}`}
            color={summary.net < 0 ? "#ff6a5c" : "#5cff8a"}
          />
          <LcdTile label="Base (keep)" value={formatCentsAbs(summary.base)} />
          <LcdTile label="Living (needs)" value={formatCentsAbs(summary.living)} color="#ffd24a" />
          <LcdTile label="Luxury (wants)" value={formatCentsAbs(summary.luxury)} color="#ff9a5c" />
        </div>
      </Card>

      <Card>
        <CardHeader title="📊 Spending by class, month by month" />
        <div className="bg-ledger p-3">
          {hasAnySpend ? (
            <SpendStackChart data={chartData} />
          ) : (
            <EmptyState
              title="This chapter is still blank"
              detail="Import a statement and sort some coins to chart the household saga."
            >
              <Link to="/import" className="bevel-btn px-3 py-1 text-[11px] font-bold">
                📥 To the Receiving Dock
              </Link>
            </EmptyState>
          )}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="🏆 Where the gold goes" />
          {top.length === 0 ? (
            <div className="bg-ledger p-3">
              <EmptyState title="No spoils recorded yet" />
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
          <CardHeader title="💎 Treasure hoards over time" />
          <div className="bg-ledger p-3">
            {trends.length === 0 ? (
              <EmptyState
                title="No hoards charted"
                detail="Set a balance in the Counting House, or import a statement that carries one."
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
