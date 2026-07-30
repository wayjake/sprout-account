import { redirect } from "react-router";
import { PANE_PARAM } from "~/lib/panes";

/**
 * Accounts used to be a full page. It is now a modal pane over the dashboard,
 * so old links and bookmarks land there instead.
 */
export function loader() {
  return redirect(`/?${PANE_PARAM}=accounts`);
}
