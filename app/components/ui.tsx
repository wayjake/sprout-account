import type { ClearedState } from "~/.server/balances";
import type { SpendingClass } from "~/db/schema";

const CLEARED_MARKS: Record<ClearedState, { mark: string; cls: string; title: string }> = {
  reconciled: {
    mark: "✓",
    cls: "text-positive",
    title: "Reconciled — the statement period this row falls in ties out exactly",
  },
  mismatch: {
    mark: "!",
    cls: "text-negative",
    title:
      "In a statement period that does not tie out — see Account Balances for what is off",
  },
  open: {
    mark: "·",
    cls: "text-gray-400",
    title: "Not yet checked — no closed statement period covers this date",
  },
};

/**
 * Whether a row has been through a month-end close. Derived from the period it
 * sits in rather than stored on the row, so it stays honest when a row changes.
 */
export function ClearedMark({ state }: { state: ClearedState }) {
  const { mark, cls, title } = CLEARED_MARKS[state];
  return (
    <span
      className={`font-mono text-[12px] font-bold ${cls}`}
      title={title}
      aria-label={title}
    >
      {mark}
    </span>
  );
}

export const CLASS_LABELS: Record<SpendingClass, string> = {
  base: "Base",
  living: "Living",
  luxury: "Luxury",
  income: "Income",
  transfer: "Transfer",
};

export const CLASS_BADGE_STYLES: Record<SpendingClass, string> = {
  base: "bg-class-base text-white",
  living: "bg-class-living text-white",
  luxury: "bg-class-luxury text-white",
  income: "bg-class-income text-white",
  transfer: "bg-class-transfer text-white",
};

export const CLASS_DOT_STYLES: Record<SpendingClass, string> = {
  base: "bg-class-base",
  living: "bg-class-living",
  luxury: "bg-class-luxury",
  income: "bg-class-income",
  transfer: "bg-class-transfer",
};

export function ClassBadge({ spendingClass }: { spendingClass: SpendingClass }) {
  return (
    <span
      className={`inline-flex items-center border border-black/30 px-1.5 text-[10px] font-bold uppercase tracking-wide ${CLASS_BADGE_STYLES[spendingClass]}`}
      style={{ textShadow: "1px 1px 0 rgba(0,0,0,.35)" }}
    >
      {CLASS_LABELS[spendingClass]}
    </span>
  );
}

/** A classic application sub-window: chrome frame + gradient title bar. */
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`bevel-out p-[3px] ${className}`}>{children}</div>;
}

export function CardHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="titlebar mb-[3px] flex min-h-[24px] items-center justify-between gap-2 px-2 py-[3px]">
      <h2 className="truncate text-[12px] font-bold">{title}</h2>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <span className="hidden gap-[2px] sm:flex" aria-hidden>
          <span className="titlebar-btn">–</span>
          <span className="titlebar-btn">□</span>
          <span className="titlebar-btn">✕</span>
        </span>
      </div>
    </div>
  );
}

/**
 * A small standing label — "BETA" on a feature still finding its feet. Not a
 * status: a status changes as you use the screen, this one is a property of the
 * screen itself, so it sits in the title bar and stays put.
 */
export function Badge({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="bevel-out bg-class-luxury px-1 py-[1px] text-[9px] font-bold uppercase tracking-wide text-white"
    >
      {children}
    </span>
  );
}

/** White inner surface for window content. */
export function CardBody({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`bg-ledger ${className}`}>{children}</div>;
}

const buttonVariants = {
  primary: "bevel-btn font-bold text-primary-900",
  secondary: "bevel-btn text-black",
  danger: "bevel-btn font-bold text-negative",
  ghost: "bevel-btn text-black",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: "sm" | "md";
}) {
  const sizeCls =
    size === "sm" ? "px-2.5 py-[3px] text-[11px]" : "px-4 py-[5px] text-[12px]";
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap disabled:text-chrome-dark disabled:[text-shadow:1px_1px_0_#fff] ${sizeCls} ${buttonVariants[variant]} ${className}`}
      {...props}
    >
      <span className="inline-flex items-center gap-1.5">{children}</span>
    </button>
  );
}

export const inputClass =
  "field-inset w-full px-2 py-[4px] text-[12px] text-black placeholder:text-gray-500";

export const fileInputClass =
  "field-inset file-bevel block w-full p-[3px] text-[12px] text-black";

export const selectClass =
  "field-inset px-1.5 py-[4px] text-[12px] text-black";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold text-gray-800">
        {label}:
      </span>
      {children}
    </label>
  );
}

export function EmptyState({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="groove m-1 flex flex-col items-center gap-2 bg-ledger px-6 py-10 text-center">
      <p className="text-2xl" aria-hidden>
        🪶
      </p>
      <p className="text-[13px] font-bold text-primary-900">{title}</p>
      {detail && <p className="max-w-md text-[12px] text-gray-600">{detail}</p>}
      {children}
    </div>
  );
}

export function Amount({ cents, bold = false }: { cents: number; bold?: boolean }) {
  const cls = cents < 0 ? "text-black" : "text-positive";
  return (
    <span
      className={`font-mono tabular-nums text-[12px] ${cls} ${bold ? "font-bold" : ""}`}
    >
      {cents < 0 ? "−" : "+"}
      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
        Math.abs(cents) / 100,
      )}
    </span>
  );
}

/**
 * Segmented progress bar, the 1999 kind. `max` of 0 renders an empty trough,
 * which is what a run that hasn't been measured yet should look like.
 */
export function ProgressBar({
  value,
  max,
  label,
  className = "",
}: {
  value: number;
  max: number;
  label?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className={`field-inset h-[14px] p-[2px] ${className}`}
    >
      <div
        className="h-full transition-[width] duration-200 ease-linear"
        style={{
          width: `${pct}%`,
          background:
            "repeating-linear-gradient(90deg, var(--color-primary-600) 0 7px, transparent 7px 9px)",
        }}
      />
    </div>
  );
}

/** Inline message boxes, dialog-style. */
export function MessageBar({
  kind,
  children,
}: {
  kind: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  const icon = kind === "error" ? "⛔" : kind === "success" ? "✅" : "💡";
  return (
    <div className="bevel-out p-[3px]">
      <div
        className={`flex items-center gap-2 px-3 py-2 text-[12px] ${
          kind === "error" ? "bg-[#ffefef] text-negative" : "bg-ledger text-gray-800"
        }`}
      >
        <span aria-hidden>{icon}</span>
        <span>{children}</span>
      </div>
    </div>
  );
}
