import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from "react-router";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { accountBalances } from "~/.server/balances";
import { MenuBar, type MenuDef, type MenuEntry } from "~/components/menubar";
import { formatCents } from "~/lib/money";
import { paneHref } from "~/lib/panes";
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
          <span className="text-[12px] font-bold">Sprout Account — Error</span>
          <span className="titlebar-btn">✕</span>
        </div>
        <div className="flex items-start gap-4 p-5">
          <span className="text-4xl" aria-hidden>
            🥀
          </span>
          <div>
            <p className="text-[13px] font-bold">
              {isRouteErrorResponse(error) && error.status === 404
                ? "That page could not be found."
                : "Something went wrong."}
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
  { to: "/", icon: "🗺️", label: "Dashboard", end: true, title: "Dashboard (accounting workflow overview)" },
  { to: "/transactions", icon: "📒", label: "Transactions", title: "Transactions (the household register)" },
  { to: "/import", icon: "📥", label: "Transaction Import", end: true, title: "Transaction import (CSV exports into the register)" },
  { to: "/reconcile", icon: "⚖️", label: "Monthly Reconcile", title: "Monthly reconcile (close the books against PDF statements)" },
  { to: "/import/bulk", icon: "📚", label: "Bulk Statements", title: "Bulk statement import — beta (a whole folder of PDF statements, unattended)" },
  { to: "/balances", icon: "🏦", label: "Account Balances", title: "Account balances (known balances and reconciliation)" },
  { to: "/categories", icon: "🏷️", label: "Categories", title: "Categories (spending classes and category list)" },
  { to: "/transfers", icon: "⛴️", label: "Transfers", title: "Transfers (money moved between your own accounts)" },
  { to: "/amazon", icon: "📦", label: "Amazon Matching", title: "Amazon matching (match orders to card charges)" },
  { to: "/backups", icon: "💾", label: "Backups & Restore", title: "Backups and restore (snapshots of your ledger)" },
];

/**
 * The menu bar. Screens are reachable from the toolbar too; the menus are how
 * you get at the things that have no toolbar button — the settings panes
 * (`?pane=`), and the desktop window commands.
 *
 * Items with nowhere to go are declared `unavailable` rather than omitted: the
 * menus are part of the 1999 costume, and a greyed item is honest about it.
 */
function buildMenus({
  location,
  desktop,
}: {
  location: { pathname: string; search: string };
  desktop: ReturnType<typeof useDesktopWindow>;
}): MenuDef[] {
  const desktopOnly = (label: string, onSelect: () => void): MenuEntry =>
    desktop.isDesktop
      ? { kind: "action", label, onSelect }
      : {
          kind: "unavailable",
          label,
          note: "Available in the desktop app, where this window is the real window.",
        };

  return [
    {
      label: "File",
      items: [
        { kind: "link", label: "Import Transactions…", to: "/import" },
        { kind: "link", label: "Reconcile a Month…", to: "/reconcile" },
        { kind: "link", label: "Bulk Import Statements… (beta)", to: "/import/bulk" },
        { kind: "link", label: "Backups & Restore…", to: "/backups" },
        { kind: "separator" },
        desktopOnly("Close Window", desktop.close),
      ],
    },
    {
      label: "Edit",
      items: [
        { kind: "unavailable", label: "Undo", note: "Not wired up." },
        { kind: "unavailable", label: "Cut", note: "Use your browser or system clipboard." },
        { kind: "unavailable", label: "Copy", note: "Use your browser or system clipboard." },
        { kind: "unavailable", label: "Paste", note: "Use your browser or system clipboard." },
        { kind: "separator" },
        { kind: "unavailable", label: "Preferences…", note: "There are no preferences yet." },
      ],
    },
    {
      label: "Lists",
      items: [
        { kind: "link", label: "Accounts…", to: paneHref(location, "accounts") },
        { kind: "link", label: "Categories", to: "/categories" },
        { kind: "separator" },
        { kind: "link", label: "Transactions", to: "/transactions" },
        { kind: "link", label: "Transfers", to: "/transfers" },
        { kind: "link", label: "Amazon Orders", to: "/amazon" },
      ],
    },
    {
      label: "Tools",
      items: [
        { kind: "link", label: "Transaction Import", to: "/import" },
        { kind: "link", label: "Bulk Statement Import (beta)", to: "/import/bulk" },
        { kind: "link", label: "Transfer Detection", to: "/transfers" },
        { kind: "link", label: "Amazon Matching", to: "/amazon" },
        { kind: "separator" },
        { kind: "link", label: "Monthly Reconcile", to: "/reconcile" },
        { kind: "link", label: "Account Balances", to: "/balances" },
      ],
    },
    {
      label: "Reports",
      items: [
        { kind: "link", label: "Dashboard", to: "/" },
        { kind: "link", label: "Account Balances", to: "/balances" },
        { kind: "link", label: "Uncategorized Transactions", to: "/transactions?category=none" },
        { kind: "separator" },
        { kind: "unavailable", label: "Print…", note: "No printing yet." },
      ],
    },
    {
      label: "Window",
      items: [
        desktopOnly("Minimize", desktop.minimize),
        desktopOnly("Zoom", desktop.toggleMaximize),
        { kind: "separator" },
        { kind: "unavailable", label: "Cascade", note: "One window is all you get." },
        { kind: "unavailable", label: "Tile Horizontally", note: "One window is all you get." },
      ],
    },
    {
      label: "Help",
      items: [
        { kind: "link", label: "About Sprout Account…", to: paneHref(location, "about") },
        { kind: "separator" },
        { kind: "unavailable", label: "Contents and Index", note: "No help file. Sorry." },
      ],
    },
  ];
}

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
  "Every backup is a good backup.",
  "Every receipt tells a story.",
  "Compound interest compounds onward.",
  "Tip: a categorized transaction is a happy transaction.",
  "The abacus is warm and ready.",
  "Double-entry, double the confidence.",
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
            <span aria-hidden>🌱</span> Sprout Account — Household Ledger
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

        <MenuBar menus={buildMenus({ location, desktop })} />

        {/* Toolbar — buttons keep one height; the row scrolls before it squashes */}
        <div className="flex items-stretch gap-[3px] overflow-x-auto border-b-2 border-chrome-dark/30 bg-chrome p-[4px]">
          {TOOLBAR.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.title}
              className="shrink-0"
            >
              {({ isActive }) => (
                <span
                  data-pressed={isActive}
                  className="bevel-btn relative flex h-full w-[76px] flex-col items-center gap-[3px] px-1 py-[5px]"
                >
                  <span className="text-xl leading-none" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="text-center text-[10px] font-bold leading-tight">
                    {item.label}
                  </span>
                  {item.to === "/transactions" && uncategorizedCount > 0 && (
                    <span
                      className="absolute right-[2px] top-[2px] bg-class-living px-[3px] text-[9px] font-bold leading-[1.4] text-white"
                      title={`${uncategorizedCount.toLocaleString()} uncategorized`}
                    >
                      {uncategorizedCount > 999 ? "999+" : uncategorizedCount}
                    </span>
                  )}
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
                  💰 Accounts
                </p>
                {transactionAccounts.length === 0 && (
                  <p className="mb-2 pl-1 text-[11px] italic text-gray-500">
                    None yet —{" "}
                    <Link
                      to={paneHref(location, "accounts")}
                      className="underline hover:text-primary-800"
                    >
                      add an account
                    </Link>
                    .
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
                  🏰 Savings Goals
                </p>
                {balanceAccounts.length === 0 && (
                  <p className="pl-1 text-[11px] italic text-gray-500">
                    No savings goals tracked yet.
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
          <main className="bevel-in min-w-0 flex-1 overflow-y-auto bg-[#e8efe6] p-2 sm:p-3 lg:p-4">
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
              ? "✅ all categorized"
              : `🏷️ ${uncategorizedCount.toLocaleString()} uncategorized`}
          </span>
          <span className="bevel-in px-2 py-[2px]">NUM</span>
        </div>
      </div>
    </div>
  );
}
