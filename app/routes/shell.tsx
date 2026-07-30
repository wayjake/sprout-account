import { useEffect, useState } from "react";
import { NavLink, Outlet, isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { accountBalances } from "~/.server/balances";
import { formatCents } from "~/lib/money";
import type { Route } from "./+types/shell";

export async function loader(_: Route.LoaderArgs) {
  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true))
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);

  // Derived: last known balance plus everything recorded since.
  const derived = await accountBalances();

  const categories = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.isArchived, false))
    .orderBy(schema.categories.sortOrder, schema.categories.name);

  const [txnCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.transactions);
  const uncategorizedCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.transactions)
    .where(sql`${schema.transactions.categoryId} is null`);

  return {
    accounts,
    categories,
    balancesByAccount: Object.fromEntries(
      derived
        .filter((b) => !b.unanchored && b.currentCents != null)
        .map((b) => [b.account.id, b.currentCents!]),
    ),
    txnCount: txnCount.count,
    uncategorizedCount: uncategorizedCount[0]?.count ?? 0,
  };
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? typeof error.data === "string"
      ? error.data
      : error.statusText || `Error ${error.status}`
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="bevel-out w-[420px] p-[3px]">
        <div className="titlebar flex items-center justify-between px-2 py-1">
          <span className="text-[12px] font-bold">Sprout Account — Mishap!</span>
          <span className="titlebar-btn">✕</span>
        </div>
        <div className="flex items-start gap-4 p-5">
          <span className="text-4xl" aria-hidden>
            🥀
          </span>
          <div>
            <p className="text-[13px] font-bold">
              {isRouteErrorResponse(error) && error.status === 404
                ? "That page fell out of the ledger."
                : "A gremlin got into the books."}
            </p>
            <p className="mt-1 text-[12px] text-gray-700">{message}</p>
            <a href="/" className="bevel-btn mt-4 inline-block px-4 py-1 text-[12px] font-bold">
              OK
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

const TOOLBAR = [
  { to: "/", icon: "🗺️", label: "Adventure", end: true, title: "The Adventure Map (Dashboard)" },
  { to: "/transactions", icon: "📒", label: "Register", title: "The Great Ledger (Transactions)" },
  { to: "/import", icon: "📥", label: "Import", title: "The Receiving Dock (Import statements)" },
  { to: "/balances", icon: "🏦", label: "Balances", title: "The Counting House (Account balances)" },
  { to: "/categories", icon: "🏷️", label: "Sort Room", title: "The Sorting Room (Categories)" },
  { to: "/transfers", icon: "⛴️", label: "Ferry", title: "The Ferry Docks (Transfers between accounts)" },
  { to: "/amazon", icon: "📦", label: "Bazaar", title: "The Endless Bazaar (Amazon matching)" },
  { to: "/backups", icon: "💾", label: "Vault", title: "The Time Vault (Backups)" },
  { to: "/accounts", icon: "⚙️", label: "Accounts", title: "The Workshop (Accounts)" },
];

const MENUS = ["File", "Edit", "Lists", "Adventurer", "Reports", "Window", "Help"];

/**
 * Detect the Tauri desktop shell. There the window is frameless
 * (decorations: false) and our retro titlebar IS the window frame — the
 * –/□/✕ buttons drive the real window via the injected global API.
 */
function useDesktopWindow() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) setIsDesktop(true);
  }, []);
  const win = () =>
    (
      window as unknown as {
        __TAURI__?: {
          window: {
            getCurrentWindow(): {
              minimize(): void;
              toggleMaximize(): void;
              close(): void;
            };
          };
        };
      }
    ).__TAURI__?.window.getCurrentWindow();
  return {
    isDesktop,
    minimize: () => win()?.minimize(),
    toggleMaximize: () => win()?.toggleMaximize(),
    close: () => win()?.close(),
  };
}

const QUIPS = [
  "The ledger balances… for now.",
  "No dragons detected in the vault.",
  "Every receipt tells a story.",
  "Ye olde compound interest compounds onward.",
  "Tip: a categorized coin is a happy coin.",
  "The abacus is warm and ready.",
  "Double-entry, double the adventure.",
];

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { accounts, balancesByAccount, txnCount, uncategorizedCount } = loaderData;
  const location = useLocation();
  const desktop = useDesktopWindow();
  const transactionAccounts = accounts.filter((a) => a.kind === "transaction");
  const balanceAccounts = accounts.filter((a) => a.kind === "balance");
  const quip =
    QUIPS[
      Math.abs(
        [...location.pathname].reduce((a, c) => a + c.charCodeAt(0), 0),
      ) % QUIPS.length
    ];

  return (
    <div
      className={
        desktop.isDesktop ? "h-screen overflow-hidden" : "min-h-screen p-3 sm:p-5"
      }
    >
      <div
        className={
          desktop.isDesktop
            ? "bevel-out flex h-full flex-col p-[3px]"
            : "bevel-out mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-[1240px] flex-col p-[3px]"
        }
      >
        {/* Title bar — in the desktop app this IS the window frame */}
        <div
          data-tauri-drag-region
          className="titlebar flex items-center justify-between px-2 py-1"
          onDoubleClick={desktop.isDesktop ? desktop.toggleMaximize : undefined}
        >
          <span
            data-tauri-drag-region
            className="pointer-events-none flex items-center gap-2 text-[12px] font-bold"
          >
            <span aria-hidden>🌱</span> Sprout Account 2000 — Accounting Adventures™
          </span>
          {desktop.isDesktop ? (
            <span className="flex gap-[2px]">
              <button
                type="button"
                className="titlebar-btn"
                title="Minimize"
                onClick={desktop.minimize}
              >
                –
              </button>
              <button
                type="button"
                className="titlebar-btn"
                title="Maximize / restore"
                onClick={desktop.toggleMaximize}
              >
                □
              </button>
              <button
                type="button"
                className="titlebar-btn"
                title="Close"
                onClick={desktop.close}
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="flex gap-[2px]" aria-hidden>
              <span className="titlebar-btn">–</span>
              <span className="titlebar-btn">□</span>
              <span className="titlebar-btn">✕</span>
            </span>
          )}
        </div>

        {/* Menu bar (purely nostalgic) */}
        <div className="flex gap-0 border-b border-chrome-dark/40 bg-chrome px-1 py-[2px] text-[12px]">
          {MENUS.map((m) => (
            <span key={m} className="menu-item cursor-default" title="Just here for the nostalgia">
              <span className="underline">{m[0]}</span>
              {m.slice(1)}
            </span>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-stretch gap-[3px] border-b-2 border-chrome-dark/30 bg-chrome p-[4px]">
          {TOOLBAR.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} title={item.title}>
              {({ isActive }) => (
                <span
                  data-pressed={isActive}
                  className="bevel-btn flex w-[72px] flex-col items-center gap-[2px] px-1 py-[5px]"
                >
                  <span className="text-xl leading-none" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="text-[10px] font-bold">
                    {item.label}
                    {item.to === "/transactions" && uncategorizedCount > 0 && (
                      <span className="ml-1 bg-class-living px-1 text-[9px] text-white">
                        {uncategorizedCount > 999 ? "999+" : uncategorizedCount}
                      </span>
                    )}
                  </span>
                </span>
              )}
            </NavLink>
          ))}
        </div>

        {/* Content row */}
        <div className="flex min-h-0 flex-1 gap-[4px] bg-chrome p-[4px]">
          {/* Company navigator panel */}
          <aside className="hidden w-52 shrink-0 flex-col lg:flex">
            <div className="bevel-out flex-1 p-[3px]">
              <div className="titlebar px-2 py-[3px] text-[11px] font-bold">
                Company Navigator
              </div>
              <div className="bevel-in mt-[3px] h-[calc(100%-26px)] overflow-y-auto bg-ledger p-2">
                <p className="mb-1 text-[10px] font-bold uppercase text-primary-800">
                  💰 Coin Purses
                </p>
                {transactionAccounts.length === 0 && (
                  <p className="mb-2 pl-1 text-[11px] italic text-gray-500">
                    None yet — visit the Workshop.
                  </p>
                )}
                {transactionAccounts.map((a) => (
                  <NavLink
                    key={a.id}
                    to={`/transactions?account=${a.id}`}
                    className="mb-[2px] flex items-center justify-between px-1 py-[2px] text-[11px] hover:bg-primary-100"
                  >
                    <span className="truncate">📘 {a.name}</span>
                    {balancesByAccount[a.id] != null ? (
                      <span
                        className={`ml-1 shrink-0 font-mono text-[10px] ${
                          balancesByAccount[a.id] < 0 ? "text-negative" : "text-primary-800"
                        }`}
                      >
                        {formatCents(balancesByAccount[a.id])}
                      </span>
                    ) : (
                      a.lastFour && (
                        <span className="ml-1 shrink-0 text-[10px] text-gray-500">
                          ··{a.lastFour}
                        </span>
                      )
                    )}
                  </NavLink>
                ))}
                <p className="mb-1 mt-3 text-[10px] font-bold uppercase text-primary-800">
                  🏰 Treasure Hoards
                </p>
                {balanceAccounts.length === 0 && (
                  <p className="pl-1 text-[11px] italic text-gray-500">
                    No hoards tracked yet.
                  </p>
                )}
                {balanceAccounts.map((a) => (
                  <div
                    key={a.id}
                    className="mb-[2px] flex items-center justify-between px-1 py-[2px] text-[11px]"
                  >
                    <span className="truncate">💎 {a.name}</span>
                    {balancesByAccount[a.id] != null && (
                      <span className="ml-1 shrink-0 font-mono text-[10px] text-primary-800">
                        {formatCents(balancesByAccount[a.id])}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </aside>

          {/* Workspace */}
          <main className="bevel-in min-w-0 flex-1 overflow-y-auto bg-[#e8efe6] p-4">
            <Outlet />
          </main>
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-[4px] bg-chrome px-[4px] pb-[2px] pt-[3px] text-[11px]">
          <span className="bevel-in flex-1 truncate px-2 py-[2px]">
            Ready. {quip}
          </span>
          <span className="bevel-in hidden px-2 py-[2px] sm:block">
            {txnCount.toLocaleString()} ledger entries
          </span>
          <span className="bevel-in hidden px-2 py-[2px] sm:block">
            {uncategorizedCount === 0
              ? "✅ all sorted"
              : `🏷️ ${uncategorizedCount.toLocaleString()} unsorted`}
          </span>
          <span className="bevel-in px-2 py-[2px]">NUM</span>
        </div>
      </div>
    </div>
  );
}
