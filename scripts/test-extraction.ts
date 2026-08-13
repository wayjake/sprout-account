/**
 * Run real statements through the same extraction path the imports use and
 * check that they tie out — the exact arithmetic `finalize` blocks a bulk run
 * on. This exists because the failure mode of statement extraction is silent
 * and statistical (a sign convention drifting mid-document, a miscounted wall
 * of identical lines), so the only meaningful test is the genuine article: a
 * real PDF, the real chunking, the real model.
 *
 * Usage:
 *   npm run test:extraction                                  # the fixture suite
 *   npm run test:extraction -- "<statement.pdf>" [accountType]
 *
 * With no arguments it runs every checked-in fixture, each one kept because it
 * broke extraction in a distinct way — the circumstances stay stapled to the
 * test:
 *
 * - apple-card-march-2026.pdf: walls of identical dispute credits the model
 *   miscounts, plus dozens of $0.05 Daily Cash Adjustment sub-lines. Exercises
 *   the signed (liability) text-layer audit and the transcribe-and-flip sign
 *   contract.
 * - wells-fargo-checking-jan-2026.pdf: every amount unsigned in
 *   Deposits/Withdrawals columns with a running-balance column to ignore, a
 *   checks summary that re-lists rows, and year-less M/D dates. AI-only
 *   extraction was off by $23,106.53 on this file. Exercises the columnar
 *   (bank) audit.
 *
 * accountType defaults to credit_card for a single file. Needs
 * OPENROUTER_API_KEY (and honours OPENROUTER_MODEL_PDF) from .env, which bun
 * loads automatically. Exits 0 when every statement ties out cleanly, 1 when
 * any would have been held.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extractFromPdf } from "~/.server/import/pdf";
import { isAccountType, isLiability } from "~/lib/accounts";
import type { AccountType } from "~/db/schema";
import { formatCents } from "~/lib/money";

const FIXTURES: { file: string; accountType: AccountType }[] = [
  { file: "apple-card-march-2026.pdf", accountType: "credit_card" },
  { file: "wells-fargo-checking-jan-2026.pdf", accountType: "checking" },
];

const args = process.argv.slice(2).filter((a) => a !== "--dump");
const dump = process.argv.includes("--dump");
const [pathArg, typeArg] = args;

async function runOne(path: string, accountType: AccountType): Promise<boolean> {
  const buffer = readFileSync(path);
  console.log(`Extracting ${basename(path)} as ${accountType} (${buffer.length} bytes)…`);
  const started = Date.now();
  const result = await extractFromPdf(buffer, basename(path), {
    kind: "transaction",
    accountType,
  });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);

  if (dump) {
    const out = `${basename(path)}.extraction.json`;
    await Bun.write(out, JSON.stringify(result, null, 2));
    console.log(`Wrote ${out}\n`);
  }

  const net = result.transactions.reduce((n, t) => n + t.amountCents, 0);
  const credits = result.transactions.filter((t) => t.amountCents > 0);
  const opening = result.balances.find((b) => b.kind === "opening");
  const closing = result.balances.find((b) => b.kind === "closing");

  console.log(`Period:       ${result.statementStart} → ${result.statementEnd}`);
  console.log(`Account:      ${result.institutionName} · ${result.accountName} ··${result.accountLastFour}`);
  console.log(`Opening:      ${opening ? `${opening.date}  ${formatCents(opening.balanceCents)}` : "—"}`);
  console.log(`Closing:      ${closing ? `${closing.date}  ${formatCents(closing.balanceCents)}` : "—"}`);
  console.log(`Rows:         ${result.transactions.length} (${credits.length} credits)`);
  console.log(`Rows net:     ${formatCents(net)}`);
  if (opening && closing) {
    const expected = closing.balanceCents - opening.balanceCents;
    console.log(`Balances move ${formatCents(expected)} → off by ${formatCents(net - expected)}`);
  }
  if (isLiability(accountType) && result.balances.length > 0) {
    const sign = result.balances.every((b) => b.balanceCents < 0)
      ? "all negative (owed) ✓"
      : "NOT all negative";
    console.log(`Balance signs: ${sign}`);
  }

  if (result.problems.length > 0) {
    console.log(`\nProblems:`);
    for (const p of result.problems) console.log(`  - ${p}`);
  }

  console.log(
    result.blocked
      ? "\nBLOCKED — this statement would be held.\n"
      : "\nTies out — this statement would commit.\n",
  );
  return !result.blocked;
}

if (pathArg) {
  const accountType = typeArg ?? "credit_card";
  if (!isAccountType(accountType)) {
    console.error(`Not an account type: ${accountType}`);
    process.exit(2);
  }
  process.exit((await runOne(pathArg, accountType)) ? 0 : 1);
}

let failed = 0;
for (const fixture of FIXTURES) {
  let ok = false;
  try {
    ok = await runOne(join(import.meta.dir, "fixtures", fixture.file), fixture.accountType);
  } catch (err) {
    // A dead API key or an empty balance is a broken test run, not a broken
    // extraction — say which fixture it hit and keep going, so one outage
    // still reports on whatever it didn't reach.
    console.log(`\nERRORED — ${err instanceof Error ? err.message : String(err)}\n`);
  }
  if (!ok) failed++;
  console.log("─".repeat(60));
}
console.log(
  failed === 0
    ? `All ${FIXTURES.length} fixtures tie out.`
    : `${failed} of ${FIXTURES.length} fixtures FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
