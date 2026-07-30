import { useMemo, useState } from "react";
import { Form, Link, data, redirect } from "react-router";
import { eq } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { headerSignature, parseCsv } from "~/.server/import/csv";
import { saveMapping } from "~/.server/import/mapping";
import { addOverlapWarning } from "~/.server/import/intake";
import {
  dedupeSessionBatches,
  discardBatch,
  readUpload,
  stageBatchRows,
} from "~/.server/import/stage";
import {
  AMOUNT_STYLES,
  DATE_FORMATS,
  MappingSchema,
  applyMapping,
  heuristicMapping,
  type Mapping,
} from "~/lib/csv-mapping";
import { Amount, Button, Card, CardHeader, Field, selectClass } from "~/components/ui";
import type { Route } from "./+types/import-map";

export function meta() {
  return [{ title: "Map CSV Columns · Sprout Account — Household Ledger" }];
}

async function loadBatch(batchId: string) {
  const batch = await db.query.importBatches.findFirst({
    where: eq(schema.importBatches.id, Number(batchId)),
    with: { account: true },
  });
  if (!batch || !batch.account) throw data("Import batch not found", { status: 404 });
  if (batch.status !== "mapping") throw redirect(`/import/${batch.id}`);
  const raw = readUpload(batch.id);
  if (!raw) throw data("Uploaded file no longer available — re-upload it.", { status: 410 });
  return { batch, account: batch.account, raw };
}

export async function loader({ params }: Route.LoaderArgs) {
  const { batch, account, raw } = await loadBatch(params.batchId);
  const { headers, records } = parseCsv(raw.toString("utf-8"));
  const kind = batch.kind === "balances" ? ("balances" as const) : ("transactions" as const);
  const stats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
  const parsedSuggestion = MappingSchema.safeParse(stats.suggestion);
  const suggestion: Mapping = parsedSuggestion.success
    ? parsedSuggestion.data
    : heuristicMapping(headers, records.slice(0, 15), kind);
  return {
    batchId: batch.id,
    accountName: account.name,
    filename: batch.filename,
    kind,
    headers,
    sampleRecords: records.slice(0, 10),
    rowCount: records.length,
    suggestion,
    suggestionSource: (stats.suggestionSource ?? "heuristic") as "ai" | "heuristic",
  };
}

function mappingFromForm(form: FormData): Mapping | null {
  const str = (k: string) => {
    const v = String(form.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const parsed = MappingSchema.safeParse({
    dateColumn: str("dateColumn") ?? "",
    dateFormat: str("dateFormat") ?? "",
    descriptionColumns: form.getAll("descriptionColumns").map(String).filter(Boolean),
    amountStyle: str("amountStyle"),
    amountColumn: str("amountColumn"),
    debitColumn: str("debitColumn"),
    creditColumn: str("creditColumn"),
    balanceColumn: str("balanceColumn"),
  });
  return parsed.success ? parsed.data : null;
}

export async function action({ params, request }: Route.ActionArgs) {
  const form = await request.formData();
  if (form.get("intent") === "discard") {
    await discardBatch(Number(params.batchId));
    return redirect("/import");
  }

  const { batch, account, raw } = await loadBatch(params.batchId);
  const kind = batch.kind === "balances" ? ("balances" as const) : ("transactions" as const);
  const mapping = mappingFromForm(form);
  if (!mapping) return data({ error: "Incomplete mapping — check the fields." }, { status: 400 });
  if (kind === "transactions" && !mapping.amountStyle) {
    return data({ error: "Choose an amount style." }, { status: 400 });
  }
  if (kind === "balances" && !mapping.balanceColumn) {
    return data({ error: "Choose the balance column." }, { status: 400 });
  }

  const { headers, records } = parseCsv(raw.toString("utf-8"));
  const { txns, balances, errors } = applyMapping(records, mapping, kind);
  if (kind === "transactions" && txns.length === 0) {
    return data(
      { error: `No rows parsed with this mapping (${errors.length} errors) — check the columns.` },
      { status: 400 },
    );
  }
  if (kind === "balances" && balances.length === 0) {
    return data({ error: "No balance rows parsed with this mapping." }, { status: 400 });
  }

  await saveMapping(account.id, headerSignature(headers), mapping);
  await stageBatchRows(batch.id, account.id, { txns, balances });

  const stats = batch.statsJson ? JSON.parse(batch.statsJson) : {};
  await db
    .update(schema.importBatches)
    .set({
      status: "review",
      // A transactions file with a running-balance column yields both
      kind:
        txns.length > 0 && balances.length > 0
          ? "statement"
          : balances.length > 0
            ? "balances"
            : "transactions",
      statsJson: JSON.stringify({ ...stats, rowErrors: errors.slice(0, 20) }),
    })
    .where(eq(schema.importBatches.id, batch.id));
  await addOverlapWarning(batch.id, account.id);
  // Now that this file has rows, see whether a sibling already covers them
  if (batch.sessionId) await dedupeSessionBatches(batch.sessionId);

  return redirect(
    batch.sessionId ? `/import/session/${batch.sessionId}` : `/import/${batch.id}`,
  );
}

export default function ImportMap({ loaderData, actionData }: Route.ComponentProps) {
  const {
    accountName,
    filename,
    kind,
    headers,
    sampleRecords,
    rowCount,
    suggestion,
    suggestionSource,
  } = loaderData;
  const [mapping, setMapping] = useState<Mapping>(suggestion);

  const preview = useMemo(
    () => applyMapping(sampleRecords, mapping, kind),
    [sampleRecords, mapping, kind],
  );

  const set = (patch: Partial<Mapping>) => setMapping((m) => ({ ...m, ...patch }));
  const columnSelect = (
    name: keyof Mapping,
    value: string | null,
    onChange: (v: string | null) => void,
    allowNone = true,
  ) => (
    <select
      name={name}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={`${selectClass} w-full`}
    >
      {allowNone && <option value="">—</option>}
      {headers.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </select>
  );

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <Link to="/import" className="text-xs font-medium text-primary-600 hover:underline">
          ← Import
        </Link>
        <h1 className="mt-1 text-[16px] font-bold text-primary-950">🗝️ Map CSV columns</h1>
        <p className="text-sm text-gray-500">
          {filename} → {accountName} · {rowCount} rows ·{" "}
          {suggestionSource === "ai"
            ? "AI suggested this mapping — confirm it below."
            : "Mapping guessed from headers — confirm it below."}{" "}
          It's saved and reused for future files with the same columns.
        </p>
      </div>

      {actionData && "error" in actionData && (
        <p className="groove bg-[#ffefef] px-3 py-1.5 text-[12px] font-bold text-negative">
          {actionData.error}
        </p>
      )}

      <Form method="post">
        <Card>
          <CardHeader title="Column mapping" />
          <div className="grid grid-cols-3 gap-3 p-4">
            <Field label="Date column">
              {columnSelect("dateColumn", mapping.dateColumn, (v) => set({ dateColumn: v ?? headers[0] }), false)}
            </Field>
            <Field label="Date format">
              <select
                name="dateFormat"
                value={mapping.dateFormat}
                onChange={(e) => set({ dateFormat: e.target.value as Mapping["dateFormat"] })}
                className={`${selectClass} w-full`}
              >
                {DATE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>

            {kind === "balances" ? (
              <Field label="Balance column">
                {columnSelect("balanceColumn", mapping.balanceColumn, (v) => set({ balanceColumn: v }))}
              </Field>
            ) : (
              <>
                <Field label="Description column(s)">
                  <select
                    name="descriptionColumns"
                    multiple
                    value={mapping.descriptionColumns}
                    onChange={(e) =>
                      set({
                        descriptionColumns: Array.from(
                          e.target.selectedOptions,
                          (o) => o.value,
                        ),
                      })
                    }
                    className={`${selectClass} h-20 w-full`}
                  >
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount style">
                  <select
                    name="amountStyle"
                    value={mapping.amountStyle ?? ""}
                    onChange={(e) =>
                      set({ amountStyle: (e.target.value || null) as Mapping["amountStyle"] })
                    }
                    className={`${selectClass} w-full`}
                  >
                    {AMOUNT_STYLES.map((s) => (
                      <option key={s} value={s}>
                        {s === "single_signed"
                          ? "One column, spending negative"
                          : s === "single_inverted"
                            ? "One column, spending positive (inverted)"
                            : "Separate debit / credit columns"}
                      </option>
                    ))}
                  </select>
                </Field>
                {mapping.amountStyle === "debit_credit" ? (
                  <>
                    <Field label="Debit column (spending)">
                      {columnSelect("debitColumn", mapping.debitColumn, (v) => set({ debitColumn: v }))}
                    </Field>
                    <Field label="Credit column (inflow)">
                      {columnSelect("creditColumn", mapping.creditColumn, (v) => set({ creditColumn: v }))}
                    </Field>
                  </>
                ) : (
                  <Field label="Amount column">
                    {columnSelect("amountColumn", mapping.amountColumn, (v) => set({ amountColumn: v }))}
                  </Field>
                )}
                <Field label="Running balance column (optional)">
                  {columnSelect("balanceColumn", mapping.balanceColumn, (v) =>
                    set({ balanceColumn: v }),
                  )}
                </Field>
              </>
            )}
          </div>
          {kind === "transactions" && (
            <p className="px-4 pb-3 text-[11px] text-gray-500">
              If this export carries a running balance, mapping it records the closing
              balance for each day — that is what lets the ledger check itself.
            </p>
          )}
        </Card>

        <Card className="mt-4">
          <CardHeader title={`Preview (first ${sampleRecords.length} rows)`} />
          {preview.errors.length > 0 && (
            <p className="border-b border-primary-100 bg-class-living/10 px-4 py-2 text-xs text-class-living">
              {preview.errors.length} of {sampleRecords.length} preview rows failed to
              parse — adjust the mapping if that looks wrong.
            </p>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-primary-100 bg-primary-50/60 text-left text-xs font-semibold text-primary-800">
                <th className="px-4 py-2">Date</th>
                {kind === "transactions" && <th className="px-4 py-2">Description</th>}
                <th className="px-4 py-2 text-right">
                  {kind === "balances" ? "Balance" : "Amount"}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-primary-50">
              {(kind === "balances" ? preview.balances : preview.txns).map((row, i) => (
                <tr key={i}>
                  <td className="px-4 py-1.5 text-gray-500">{row.date}</td>
                  {kind === "transactions" && "description" in row && (
                    <td className="max-w-96 truncate px-4 py-1.5">{row.description}</td>
                  )}
                  <td className="px-4 py-1.5 text-right">
                    <Amount
                      cents={"amountCents" in row ? row.amountCents : row.balanceCents}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="mt-4 flex justify-between">
          <Button name="intent" value="discard" variant="danger" formNoValidate>
            Discard import
          </Button>
          <Button type="submit" name="intent" value="confirm">
            Looks right — stage {rowCount} rows
          </Button>
        </div>
      </Form>
    </div>
  );
}
