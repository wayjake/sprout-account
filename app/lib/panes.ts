/**
 * Settings panes live in the URL as `?pane=accounts`.
 *
 * They are deliberately *not* their own paths: a pane opens as a modal window
 * over whatever screen you were on, and the screen underneath has to stay
 * mounted (and stay scrolled where it was). A pathless layout route
 * (`routes/settings-pane.tsx`) reads this param, loads the pane's data, and
 * renders the modal alongside its `<Outlet />`.
 *
 * Isomorphic: the shell builds pane hrefs in the browser, the layout loader
 * parses them on the server.
 */

export const PANE_PARAM = "pane";

export const PANE_IDS = ["accounts", "about"] as const;
export type PaneId = (typeof PANE_IDS)[number];

export const PANE_TITLES: Record<PaneId, string> = {
  accounts: "Accounts",
  about: "About Sprout Account",
};

export function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && (PANE_IDS as readonly string[]).includes(value);
}

/** The open pane for a request URL, or null when the param is absent or bogus. */
export function paneFromSearch(search: string | URLSearchParams): PaneId | null {
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const value = params.get(PANE_PARAM);
  return isPaneId(value) ? value : null;
}

/**
 * What a pane's action route replies with. `ok` carries the intent that
 * succeeded so the pane can react (close an editor, reset a form).
 */
export interface PaneActionResult {
  ok?: string;
  error?: string;
}

type PartialLocation = { pathname: string; search: string };

/** Href that opens `pane` over the current screen, keeping its other params. */
export function paneHref(location: PartialLocation, pane: PaneId): string {
  const params = new URLSearchParams(location.search);
  params.set(PANE_PARAM, pane);
  return `${location.pathname}?${params.toString()}`;
}

/** Href for the same screen with no pane open — i.e. the close button. */
export function paneClosedHref(location: PartialLocation): string {
  const params = new URLSearchParams(location.search);
  params.delete(PANE_PARAM);
  const search = params.toString();
  return search ? `${location.pathname}?${search}` : location.pathname;
}
