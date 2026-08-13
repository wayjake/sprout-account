import { PDFDocument } from "pdf-lib";

/**
 * Pages per request when a statement is split.
 *
 * The limit that matters is the *output* length, not the input: extraction of a
 * long statement silently truncates rather than erroring. Measured against a
 * 22-page Apple Card statement, single pages (27 rows), three pages (81) and
 * six pages (163) all came back exact, eleven pages returned 253 where at least
 * 266 were printed, and the whole file landed anywhere from 463 to 525 against
 * a true 589 — off by as much as $1,085.
 *
 * So the budget is rows, and pages are only a proxy for it. A page runs ~27
 * rows where every line is a transaction but ~38 where returns carry their
 * reward-reversal sub-lines, and it is the dense pages that decide this: five
 * of them came to 189 rows, past the point where rows start disappearing.
 * Three keeps the worst case near 115, inside the range that was exact every
 * time, without making a short statement pay for a long one.
 */
export const CHUNK_PAGES = 3;

/**
 * Below this, a statement goes in one request. Splitting is not free — each
 * piece carries its own copy of the embedded font subsets, so a split page runs
 * ~355KB where the whole 22-page file is 1.1MB — and a short statement is
 * nowhere near the length where extraction starts dropping rows.
 */
export const SPLIT_ABOVE_PAGES = 6;

export interface PdfChunk {
  buffer: Buffer;
  /** 1-based page range this chunk covers, for labelling the request */
  firstPage: number;
  lastPage: number;
}

/**
 * Cut a statement into page ranges small enough to extract exactly.
 *
 * Chunks are contiguous and cover every page, so nothing is skipped on the
 * assumption that a page holds no transactions — the summary and legal pages at
 * the back simply come back empty. Page 1 rides along in the first chunk, which
 * is where the balances and the statement period are printed.
 *
 * A boundary cannot orphan part of a transaction: a statement keeps a line and
 * its indented sub-lines together on one page, so no page begins mid-row. A
 * PDF too damaged to parse is not an error worth failing the upload over —
 * fall back to sending the file whole and let extraction do what it can.
 */
export async function splitPdfPages(buffer: Buffer): Promise<PdfChunk[]> {
  const whole = [{ buffer, firstPage: 1, lastPage: 0 }];
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch {
    return whole;
  }

  const total = src.getPageCount();
  if (total <= SPLIT_ABOVE_PAGES) return [{ buffer, firstPage: 1, lastPage: total }];

  const chunks: PdfChunk[] = [];
  for (let start = 0; start < total; start += CHUNK_PAGES) {
    const indices = Array.from(
      { length: Math.min(CHUNK_PAGES, total - start) },
      (_, i) => start + i,
    );
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, indices);
    for (const page of pages) doc.addPage(page);
    chunks.push({
      buffer: Buffer.from(await doc.save()),
      firstPage: start + 1,
      lastPage: start + indices.length,
    });
  }
  return chunks;
}

/**
 * Just page 1, for the identify pass — the institution, the account number and
 * the period are printed there, and none of the rows are wanted.
 *
 * `splitPdfPages` is no substitute: it hands back the whole file as a single
 * chunk at `SPLIT_ABOVE_PAGES` or fewer, so asking it for a "first chunk" would
 * send an entire short statement to be read for two fields.
 *
 * Falls back to the whole file when the PDF cannot be parsed, exactly as
 * `splitPdfPages` does — a damaged file is extraction's problem to report, not
 * a reason to fail before it is even looked at.
 */
export async function firstPageOnly(buffer: Buffer): Promise<Buffer> {
  try {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    if (src.getPageCount() <= 1) return buffer;
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [0]);
    doc.addPage(page);
    return Buffer.from(await doc.save());
  } catch {
    return buffer;
  }
}

/**
 * Run `worker` over every item with at most `limit` in flight, preserving input
 * order in the result. Extraction is one network call per chunk: firing twenty
 * at once invites the rate limiting that degrades a response into a plausible
 * but wrong answer, and running them one at a time makes a long statement take
 * minutes.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}
