import { exportRules, rulesFilename } from "~/.server/rules";
import type { Route } from "./+types/api.rules-export";

/**
 * Download the categorization rules as JSON. A loader-only resource route:
 * there is no component, the response *is* the file. Registered outside the
 * shell and settings-pane layouts so a download doesn't drag their loaders
 * along.
 */
export async function loader(_: Route.LoaderArgs) {
  const rules = await exportRules();
  return new Response(JSON.stringify(rules, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${rulesFilename()}"`,
      "Cache-Control": "no-store",
    },
  });
}
