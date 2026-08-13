import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "~/.server/db";
import { reconcileAccounts } from "~/.server/balances";
import { AI_BATCH_SIZE, categorizeTransactions } from "~/.server/categorize";
import {
  identifyStatement,
  proposeAccountFromStatement,
  type ProposedAccount,
  type StatementIdentification,
} from "~/.server/import/identify";
import {
  intakeStatement,
  isPdf,
  resolveStatementAccount,
} from "~/.server/import/intake";
import { mapWithConcurrency } from "~/.server/import/pdf-split";
import {
  commitBatch,
  createSession,
  dedupeSessionBatches,
  deleteUpload,
  discardBatch,
  discardSession,
  findPriorCommit,
  pendingRowsForBatches,
  readUpload,
  saveUpload,
  sha256,
  type CommitStats,
} from "~/.server/import/stage";
import { AiError } from "~/.server/openrouter";
import { autoLinkAccountTransfers, autoLinkTransfers } from "~/.server/transfers";
import { accountLabel, isAccountType, resolveAccountKind } from "~/lib/accounts";
import type { Account, BulkFile, BulkFileStatus } from "~/db/schema";

/**
 * Bulk Statement Import — a folder of statements, unattended.
 *
 * The close (`/reconcile`) reads a handful of statements inside one request and
 * redirects when it is finished. That does not scale to a folder: sixty
 * statements is an hour of AI calls, and a request nobody can watch, resume or
 * stop. So the work is broken into steps, each step is one POST, and every
 * scrap of state lives in the database — `bulk_files` for where each statement
 * has got to, `import_sessions.bulkStateJson` for the run itself. Closing the
 * tab pauses the run rather than losing it.
 *
 * The phases are in a fixed order, and one ordering constraint is load-bearing:
 * **nothing commits until every file has staged.** `dedupeSessionBatches`
 * decides which of several overlapping statements owns a row, and it can only
 * choose once they are all in front of it. Committing file by file would put
 * statement N's rows in the ledger before statement N+1 stages, leaving overlap
 * resolution to fall back on ordinary dedupe — and two statements covering the
 * same fortnight would quietly import it twice.
 */

/** One upload's ceiling. Past this, do it in two goes. */
export const MAX_BULK_FILES = 200;

/** Statements identified per step. Extraction is a step of its own, one file at
 *  a time, because it already fans its own pages out concurrently. */
const IDENTIFY_CONCURRENCY = 3;

export type BulkPhase = "scan" | "dedupe" | "commit" | "categorize" | "done";

export interface BulkStats {
  inserted: number;
  balancesRecorded: number;
  accountsCreated: number;
  transfersLinked: number;
  accountsLinked: number;
  categorized: number;
}

export interface BulkState {
  phase: BulkPhase;
  /**
   * A lid on the driver rather than a phase of its own: the run has to
   * remember where it had got to in order to carry on from there.
   */
  paused: boolean;
  /** Create accounts for statements that match none, instead of asking. */
  autoCreate: boolean;
  /** Commit each statement once the whole folder has staged. */
  autoCommit: boolean;
  /**
   * The transactions this run will offer the categorizer, settled once when the
   * phase begins. The passes deliberately leave rows uncategorized — low
   * confidence, guard-blocked — so a "next N uncategorized" query would hand
   * back the same rows for ever. Held here rather than in the browser because
   * the run has to survive a reload.
   */
  categorizeIds: number[] | null;
  categorizeDone: number;
  stats: BulkStats;
}

const emptyStats = (): BulkStats => ({
  inserted: 0,
  balancesRecorded: 0,
  accountsCreated: 0,
  transfersLinked: 0,
  accountsLinked: 0,
  categorized: 0,
});

function defaultState(opts?: Partial<BulkState>): BulkState {
  return {
    phase: "scan",
    paused: false,
    autoCreate: true,
    autoCommit: true,
    categorizeIds: null,
    categorizeDone: 0,
    stats: emptyStats(),
    ...opts,
  };
}

/**
 * A question the run cannot answer for itself, parked on the file it is about.
 *
 * Deliberately a closed set rather than an open conversation: a question is a
 * fork the pipeline actually has, and the answer is applied by code that
 * already exists. Only one fork qualifies today — which account this statement
 * belongs to, when nothing on it matched and the run was told not to create
 * accounts. The options and the proposal both come out of what the AI read off
 * page 1. A union of one, because the next kind should slot in beside it.
 */
export type BulkQuestion = {
  kind: "account";
  prompt: string;
  options: { accountId: number; label: string }[];
  proposal: ProposedAccount;
};

export function parseQuestion(json: string | null): BulkQuestion | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as BulkQuestion;
  } catch {
    return null;
  }
}

// --- run lifecycle -----------------------------------------------------------

export interface BulkUploadFile {
  name: string;
  relPath: string | null;
  /**
   * Read lazily, one at a time. Two hundred statements read up front would hold
   * the whole folder in memory at once on top of the copy the request already
   * made of it.
   */
  read: () => Promise<Buffer>;
}

export interface BulkUploadResult {
  /** Null when the folder held no statements — there is no run to go to. */
  sessionId: number | null;
  accepted: number;
  /** Files in the folder that were not statements, listed rather than refused. */
  skipped: string[];
}

/**
 * Take the upload and stop. Nothing is read here: the files are written to disk,
 * a row per file records that they are waiting, and the browser is sent to the
 * run view — which is what makes the work resumable, since by the time anything
 * expensive happens it is all recoverable from the database.
 *
 * Non-PDFs are skipped and named, not refused. `/reconcile` rejects a whole
 * upload containing a CSV on purpose — there, a CSV means you are on the wrong
 * screen. Here you pointed at a folder, and a folder having a `.DS_Store` or a
 * README in it is not a mistake about anything.
 */
export async function createBulkRun(
  files: BulkUploadFile[],
  opts: { autoCreate?: boolean; autoCommit?: boolean } = {},
): Promise<BulkUploadResult> {
  const statements = files.filter((f) => isPdf({ name: f.name }));
  const skipped = files.filter((f) => !isPdf({ name: f.name })).map((f) => f.name);
  // A folder with nothing to read is not a run that happens to be empty — it is
  // the wrong folder. Leaving a session behind would put it in the history as
  // though something had been attempted.
  if (statements.length === 0) return { sessionId: null, accepted: 0, skipped };

  const session = await createSession("bulk");
  await db
    .update(schema.importSessions)
    .set({
      bulkStateJson: JSON.stringify(
        defaultState({
          autoCreate: opts.autoCreate ?? true,
          autoCommit: opts.autoCommit ?? true,
        }),
      ),
      notesJson: skipped.length
        ? JSON.stringify(
            skipped.map((filename) => ({
              filename,
              error: "Not a PDF statement — skipped.",
            })),
          )
        : null,
    })
    .where(eq(schema.importSessions.id, session.id));

  for (const [index, file] of statements.entries()) {
    const buffer = await file.read();
    const [row] = await db
      .insert(schema.bulkFiles)
      .values({
        sessionId: session.id,
        orderIndex: index,
        filename: file.name,
        relPath: file.relPath,
        fileHash: sha256(buffer),
        sizeBytes: buffer.byteLength,
        status: "queued",
      })
      .returning({ id: schema.bulkFiles.id });
    saveUpload(row.id, buffer, "bulk");
  }

  return { sessionId: session.id, accepted: statements.length, skipped };
}

export async function loadBulkState(sessionId: number): Promise<BulkState | null> {
  const session = await db.query.importSessions.findFirst({
    where: eq(schema.importSessions.id, sessionId),
  });
  if (!session || session.purpose !== "bulk") return null;
  if (!session.bulkStateJson) return defaultState();
  try {
    return { ...defaultState(), ...(JSON.parse(session.bulkStateJson) as BulkState) };
  } catch {
    return defaultState();
  }
}

async function saveBulkState(sessionId: number, state: BulkState) {
  await db
    .update(schema.importSessions)
    .set({ bulkStateJson: JSON.stringify(state) })
    .where(eq(schema.importSessions.id, sessionId));
}

export async function setBulkPaused(sessionId: number, paused: boolean) {
  const state = await loadBulkState(sessionId);
  if (!state) return;
  await saveBulkState(sessionId, { ...state, paused });
}

export async function discardBulkRun(sessionId: number) {
  const files = await db
    .select({ id: schema.bulkFiles.id })
    .from(schema.bulkFiles)
    .where(eq(schema.bulkFiles.sessionId, sessionId));
  for (const f of files) deleteUpload(f.id, "bulk");
  await discardSession(sessionId);
}

// --- progress ----------------------------------------------------------------

export interface BulkProgress {
  sessionId: number;
  phase: BulkPhase;
  paused: boolean;
  /** Questions are outstanding — the driver stops until they are answered. */
  waiting: boolean;
  done: boolean;
  total: number;
  counts: Record<BulkFileStatus, number>;
  categorize: { total: number; done: number };
  stats: BulkStats;
}

const ZERO_COUNTS = (): Record<BulkFileStatus, number> => ({
  queued: 0,
  identified: 0,
  staged: 0,
  committed: 0,
  categorized: 0,
  needs_input: 0,
  held: 0,
  skipped: 0,
  failed: 0,
});

export async function bulkProgress(sessionId: number): Promise<BulkProgress | null> {
  const state = await loadBulkState(sessionId);
  if (!state) return null;
  const rows = await db
    .select({ status: schema.bulkFiles.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.bulkFiles)
    .where(eq(schema.bulkFiles.sessionId, sessionId))
    .groupBy(schema.bulkFiles.status);

  const counts = ZERO_COUNTS();
  for (const r of rows) counts[r.status] = r.n;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return {
    sessionId,
    phase: state.phase,
    paused: state.paused,
    waiting: counts.needs_input > 0,
    done: state.phase === "done",
    total,
    counts,
    categorize: {
      total: state.categorizeIds?.length ?? 0,
      done: state.categorizeDone,
    },
    stats: state.stats,
  };
}

export async function bulkFilesFor(sessionId: number): Promise<BulkFile[]> {
  return db
    .select()
    .from(schema.bulkFiles)
    .where(eq(schema.bulkFiles.sessionId, sessionId))
    .orderBy(asc(schema.bulkFiles.orderIndex));
}

// --- the driver --------------------------------------------------------------

/**
 * Steps in flight, per run.
 *
 * A step picks the next file by its status and only writes that status back
 * when the work is done, so two overlapping steps will both pick the *same*
 * file and both extract it — two AI passes over one statement, two batches, and
 * the second one's rows dropped on the floor by dedupe. That is exactly what
 * happened the first time a folder went through: every statement was read
 * twice. It only takes one stray second loop in the browser (a Resume on top of
 * an auto-start, an effect fired twice in development) to cause it.
 *
 * The driver is meant to be a single loop, so the fix is to make that true on
 * the server rather than to trust the client: a second caller rides along with
 * the step already running and gets its result. The map is in-process, which is
 * all this needs — one local server owns the run.
 */
const stepsInFlight = new Map<number, Promise<BulkProgress | null>>();

/**
 * Do one step's worth of work and report where the run stands. The client calls
 * this in a loop; it does not block on the whole folder, so progress lands in
 * the page as each statement is finished and a pause takes effect between
 * steps.
 */
export async function bulkStep(sessionId: number): Promise<BulkProgress | null> {
  const running = stepsInFlight.get(sessionId);
  if (running) return running;
  const step = runStep(sessionId).finally(() => stepsInFlight.delete(sessionId));
  stepsInFlight.set(sessionId, step);
  return step;
}

async function runStep(sessionId: number): Promise<BulkProgress | null> {
  const state = await loadBulkState(sessionId);
  if (!state) return null;
  if (state.paused || state.phase === "done") return bulkProgress(sessionId);

  if (state.phase === "scan") await scanStep(sessionId, state);
  else if (state.phase === "dedupe") await dedupeStep(sessionId, state);
  else if (state.phase === "commit") await commitStep(sessionId, state);
  else if (state.phase === "categorize") await categorizeStep(sessionId, state);

  return bulkProgress(sessionId);
}

/** Identify what is still unread, then extract what is identified. */
async function scanStep(sessionId: number, state: BulkState) {
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, sessionId),
        eq(schema.bulkFiles.status, "needs_input"),
      ),
    );
  // An unanswered question is not something to work around: the file it is
  // about is the one that would be imported into the wrong account.
  if (pending > 0) return;

  const queued = await db
    .select()
    .from(schema.bulkFiles)
    .where(
      and(eq(schema.bulkFiles.sessionId, sessionId), eq(schema.bulkFiles.status, "queued")),
    )
    .orderBy(asc(schema.bulkFiles.orderIndex))
    .limit(IDENTIFY_CONCURRENCY);

  if (queued.length > 0) {
    // Read the covers concurrently — one small call against page 1 each — then
    // settle the accounts one at a time. Creating accounts inside the
    // concurrent pass would let two statements for the same new account both
    // find nothing and both create it.
    const reads = await mapWithConcurrency(queued, IDENTIFY_CONCURRENCY, readCover);
    const accounts = await activeAccounts();
    let created = 0;
    for (const read of reads) {
      created += await settleAccount(read, accounts, state);
    }
    if (created > 0) {
      const latest = (await loadBulkState(sessionId)) ?? state;
      await saveBulkState(sessionId, {
        ...latest,
        stats: { ...latest.stats, accountsCreated: latest.stats.accountsCreated + created },
      });
    }
    return;
  }

  const next = await db
    .select()
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, sessionId),
        eq(schema.bulkFiles.status, "identified"),
      ),
    )
    .orderBy(asc(schema.bulkFiles.orderIndex))
    .limit(1);

  if (next.length > 0) {
    await extractFile(next[0], sessionId, state);
    return;
  }

  await saveBulkState(sessionId, { ...state, phase: "dedupe" });
}

async function activeAccounts(): Promise<Account[]> {
  return db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.isActive, true))
    .orderBy(schema.accounts.sortOrder, schema.accounts.name);
}

async function setFile(id: number, values: Partial<typeof schema.bulkFiles.$inferInsert>) {
  await db.update(schema.bulkFiles).set(values).where(eq(schema.bulkFiles.id, id));
}

type CoverRead =
  | { file: BulkFile; kind: "identity"; identity: StatementIdentification }
  | { file: BulkFile; kind: "duplicate"; priorFilename: string }
  | { file: BulkFile; kind: "failed"; error: string };

/** Read one statement's cover. No writes, so this is safe to run concurrently. */
async function readCover(file: BulkFile): Promise<CoverRead> {
  const buffer = readUpload(file.id, "bulk");
  if (!buffer) {
    return { file, kind: "failed", error: "The uploaded file is no longer on disk." };
  }
  try {
    if (file.fileHash) {
      const prior = await findPriorCommit(file.fileHash);
      if (prior) return { file, kind: "duplicate", priorFilename: prior.filename };
    }
    return {
      file,
      kind: "identity",
      identity: await identifyStatement(buffer, file.filename),
    };
  } catch (err) {
    return {
      file,
      kind: "failed",
      error:
        err instanceof AiError || err instanceof Error
          ? err.message
          : "Could not read this statement.",
    };
  }
}

/**
 * Decide which account a read belongs to and record it. Sequential, and
 * `accounts` is appended to as it goes, so a folder of twelve statements for
 * one new account creates that account once and finds it eleven times.
 *
 * Returns 1 when it created an account, so the caller can keep the tally.
 */
async function settleAccount(
  read: CoverRead,
  accounts: Account[],
  state: BulkState,
): Promise<number> {
  const file = read.file;
  if (read.kind === "failed") {
    await setFile(file.id, { status: "failed", note: read.error });
    return 0;
  }
  if (read.kind === "duplicate") {
    // Not a question. Re-running a folder that has grown by a month is the
    // normal way to use this screen, and every statement already imported would
    // otherwise stop the run dead with a prompt — sixty of them to get at the
    // one new file. An already-committed statement is the expected steady
    // state, so skip it, say so, and let it be read again deliberately.
    await setFile(file.id, {
      status: "skipped",
      note: `Already imported as "${read.priorFilename}".`,
    });
    deleteUpload(file.id, "bulk");
    return 0;
  }

  const hit = resolveStatementAccount(accounts, {
    ...read.identity,
    filename: file.relPath ?? file.filename,
  });
  // A number or a name is exact enough to act on alone. An institution is not:
  // it names a bank, not an account, and two family cards from the same issuer
  // print the same institution — filing on it unattended is how one person's
  // statements end up in the other's account. It stands only when corroborated
  // below, by the folder its file arrived in.
  if (hit.kind === "match" && hit.strength !== "institution") {
    await setFile(file.id, {
      status: "identified",
      accountId: hit.account.id,
      accountAssignment: hit.reason,
    });
    return 0;
  }

  // What its neighbours turned out to be. A folder of statements is one
  // account's statements far more often than not, and the AI does not read
  // every month the same way — one April statement out of six came back naming
  // the card scheme where the others named the issuing bank, which matched
  // nothing and quietly became a seventh account. Its five settled siblings all
  // pointed at the same place. Unanimity is the guard: a folder holding two
  // accounts has no consensus and falls through to the question below.
  const consensus = await folderConsensus(file, accounts);
  if (hit.kind === "match") {
    if (consensus?.id === hit.account.id) {
      await setFile(file.id, {
        status: "identified",
        accountId: hit.account.id,
        accountAssignment: `${hit.reason}, and the rest of this folder agrees`,
      });
      return 0;
    }
    if (await folderAlreadyAsking(file)) return 0;
    await setFile(file.id, {
      status: "needs_input",
      questionJson: JSON.stringify({
        kind: "account",
        prompt: `${file.filename}: ${hit.reason} — but that is only the institution, and nothing printed on the statement (an account number, name, or holder) says which of that institution's accounts it is.`,
        options: [hit.account, ...accounts.filter((a) => a.id !== hit.account.id)].map(
          (a) => ({ accountId: a.id, label: accountLabel(a) }),
        ),
        proposal: proposeAccountFromStatement(read.identity, file.filename),
      } satisfies BulkQuestion),
    });
    return 0;
  }
  if (consensus) {
    await setFile(file.id, {
      status: "identified",
      accountId: consensus.id,
      accountAssignment: `Same account as the rest of this folder — ${accountLabel(consensus)}`,
    });
    return 0;
  }

  const proposal = proposeAccountFromStatement(read.identity, file.filename);
  // Creating an account is only safe when the statement actually said what it
  // is. A tie means the answer is one of the accounts already on file, and
  // adding another would make the tie worse. A statement that printed neither a
  // name nor a number leaves nothing to create *from* — the proposal would be
  // named after its own account type ("Credit card"), which is not a name, and
  // would never match its own next statement either.
  const nameless = !read.identity.accountName && !read.identity.accountLastFour;
  if (!state.autoCreate || hit.kind === "ambiguous" || nameless) {
    if (await folderAlreadyAsking(file)) return 0;
    const options = (hit.kind === "ambiguous" ? hit.candidates : accounts).map((a) => ({
      accountId: a.id,
      label: accountLabel(a),
    }));
    await setFile(file.id, {
      status: "needs_input",
      questionJson: JSON.stringify({
        kind: "account",
        prompt:
          hit.kind === "ambiguous"
            ? `${file.filename}: ${hit.reason}.`
            : nameless
              ? `${file.filename} doesn't print an account name or number, so there is nothing to match it on.`
              : `Nothing on ${file.filename} matched an account on file.`,
        options,
        proposal,
      } satisfies BulkQuestion),
    });
    return 0;
  }

  const { account, created } = await findOrCreateAccount(proposal);
  if (created) accounts.push(account);
  await setFile(file.id, {
    status: "identified",
    accountId: account.id,
    accountAssignment: created
      ? `Created from this statement — ${accountLabel(account)}`
      : `From the statement — ${accountLabel(account)}`,
  });
  return created ? 1 : 0;
}

/**
 * The one account every already-settled statement in this file's folder went
 * to, or null if they disagree or there aren't any yet. Files picked
 * individually have no folder, so the run itself stands in for one.
 */
export async function folderConsensus(
  file: BulkFile,
  accounts: Account[],
): Promise<Account | null> {
  const dir = folderOf(file);
  const siblings = await db
    .select({ accountId: schema.bulkFiles.accountId, relPath: schema.bulkFiles.relPath })
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, file.sessionId),
        isNotNull(schema.bulkFiles.accountId),
      ),
    );

  const ids = new Set(
    siblings
      .filter((s) => (dir ? (s.relPath ?? "").startsWith(dir) : true))
      .map((s) => s.accountId!),
  );
  if (ids.size !== 1) return null;
  return accounts.find((a) => a.id === [...ids][0]) ?? null;
}

/** The folder a file arrived in; null for files picked individually. */
function folderOf(file: BulkFile): string | null {
  return file.relPath?.includes("/")
    ? file.relPath.slice(0, file.relPath.lastIndexOf("/") + 1)
    : null;
}

/**
 * Is a sibling from this file's folder already parked at a question? A folder
 * asks one question at a time: covers are read three at once, so when file 1
 * of a folder parks, files 2 and 3 settle right behind it in the same loop —
 * and the consensus that should have caught them cannot exist until file 1's
 * answer gives it an account. Deferring leaves the file queued; the driver
 * refuses to advance while a question is outstanding anyway, and once it is
 * answered the deferred file is re-read and lands on the folder's consensus.
 * Files with no folder share the run-stands-in-for-one rule with
 * `folderConsensus`, so any outstanding question defers them.
 */
async function folderAlreadyAsking(file: BulkFile): Promise<boolean> {
  const dir = folderOf(file);
  const parked = await db
    .select({ relPath: schema.bulkFiles.relPath })
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, file.sessionId),
        eq(schema.bulkFiles.status, "needs_input"),
      ),
    );
  return parked.some((s) => (dir ? (s.relPath ?? "").startsWith(dir) : true));
}

/**
 * The account a proposal describes, made if it isn't there yet.
 *
 * Re-checking rather than inserting blind is what stops a folder of twelve
 * monthly statements for one new account from creating twelve accounts: the
 * first file makes it, and the rest have to find it. Most will already have
 * matched in `resolveStatementAccount` by then; this covers the ones whose
 * printed name is too short or too generic for the matcher to accept.
 */
async function findOrCreateAccount(
  proposal: ProposedAccount,
): Promise<{ account: Account; created: boolean }> {
  const existing = await db.query.accounts.findFirst({
    where: and(
      eq(schema.accounts.name, proposal.name),
      eq(schema.accounts.institution, proposal.institution),
      proposal.lastFour
        ? eq(schema.accounts.lastFour, proposal.lastFour)
        : isNull(schema.accounts.lastFour),
    ),
  });
  if (existing) return { account: existing, created: false };

  const [{ max }] = await db
    .select({ max: sql<number | null>`max(${schema.accounts.sortOrder})` })
    .from(schema.accounts);
  const [account] = await db
    .insert(schema.accounts)
    .values({ ...proposal, sortOrder: (max ?? 0) + 1 })
    .returning();
  return { account, created: true };
}

/** Read the statement in full and stage it against the account's ledger. */
async function extractFile(file: BulkFile, sessionId: number, state: BulkState) {
  const buffer = readUpload(file.id, "bulk");
  const account = file.accountId
    ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, file.accountId) })
    : null;
  if (!buffer || !account) {
    await setFile(file.id, {
      status: "failed",
      note: !account ? "No account was settled for this statement." : "File missing on disk.",
    });
    return;
  }

  // A file that already carries a batch is being read a second time — an
  // answer or a retry put it back through extraction. The stale batch has to
  // go before the new read replaces it: `commitSession` walks every batch in
  // the session, and a hold only protects the file's *current* batch, so an
  // orphan from the earlier read would sail into the commit unheld. Observed
  // in the wild as two extractions of one statement, both tie-out failures,
  // only the second of which the hold covered.
  if (file.batchId) await discardBatch(file.batchId);

  const result = await intakeStatement({
    sessionId,
    file: { name: file.filename, buffer },
    defaultAccount: account,
    accounts: [account],
    account,
    accountAssignment: file.accountAssignment,
  });

  if (result.outcome === "error" || result.batchId == null) {
    // Keep the upload: a failed read is usually one flaky AI response out of
    // forty, and Try again needs the file still on disk to read it again.
    await setFile(file.id, { status: "failed", note: result.error ?? "Could not read it." });
    return;
  }

  // Two reasons to keep a statement out of the automatic commit, both of them
  // the extraction contradicting something it can be checked against.
  const missingBalance =
    account.kind === "transaction" && !(await batchHasBalance(result.batchId));
  const hold = result.blocked
    ? "The rows don't tie out to the balances printed on this statement."
    : missingBalance
      ? "No statement balance was found, so these rows could not be checked."
      : (await anchorConflict(result.batchId))
        ? "A balance on this statement disagrees with one already recorded for the same date."
        : null;

  await setFile(file.id, {
    status: hold || !state.autoCommit ? "held" : "staged",
    batchId: result.batchId,
    note: hold ?? (state.autoCommit ? null : "Waiting for you to commit it."),
  });
  // Extraction is the last thing that needs the original file.
  deleteUpload(file.id, "bulk");
}

/** A transaction statement without an anchor cannot prove that its rows are complete. */
async function batchHasBalance(batchId: number): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.stagedRows)
    .where(
      and(
        eq(schema.stagedRows.batchId, batchId),
        eq(schema.stagedRows.rowKind, "balance"),
      ),
    );
  return n > 0;
}

/**
 * Does this statement's anchor contradict one already on the books for the same
 * day? `buildBalanceRows` already answers it: a balance row matching a stored
 * snapshot's date but not its figure stages as `possible_duplicate`, because
 * committing would overwrite. Agreement is the ordinary case — a month's
 * closing anchor and the next month's opening one land on the same date by
 * design — so a disagreement is one of the two extractions being wrong, and
 * last-write-wins is no way to settle which.
 */
async function anchorConflict(batchId: number): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.stagedRows)
    .where(
      and(
        eq(schema.stagedRows.batchId, batchId),
        eq(schema.stagedRows.rowKind, "balance"),
        eq(schema.stagedRows.status, "possible_duplicate"),
      ),
    );
  return n > 0;
}

/** Settle which statement owns a row where two of them cover the same days. */
async function dedupeStep(sessionId: number, state: BulkState) {
  await discardOrphanBatches(sessionId);
  await dedupeSessionBatches(sessionId);
  await holdUnreconciledAccounts(sessionId);
  await saveBulkState(sessionId, { ...state, phase: "commit" });
}

/**
 * Remove review batches no bulk file owns. They are the durable trace of an
 * interrupted or formerly overlapping extraction; if left in the session,
 * overlap dedupe can let the orphan claim every row and leave the file that is
 * actually marked imported with zero transactions.
 */
async function discardOrphanBatches(sessionId: number) {
  const [batches, files] = await Promise.all([
    db
      .select({ id: schema.importBatches.id, status: schema.importBatches.status })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.sessionId, sessionId)),
    db
      .select({ batchId: schema.bulkFiles.batchId })
      .from(schema.bulkFiles)
      .where(eq(schema.bulkFiles.sessionId, sessionId)),
  ]);
  const owned = new Set(
    files.map((f) => f.batchId).filter((id): id is number => id != null),
  );
  for (const batch of batches) {
    if (
      !owned.has(batch.id) &&
      (batch.status === "review" || batch.status === "mapping")
    ) {
      await discardBatch(batch.id);
    }
  }
}

/**
 * A statement can look internally clean only because it supplied one balance,
 * leaving nothing inside that file to check its rows against. Once the whole
 * folder is staged, its anchors and activity form the same account windows the
 * reconciliation screen uses. Stop every still-staged file for an affected
 * account before any of them commits, so the run cannot finish green while the
 * account is already known to be off.
 */
async function holdUnreconciledAccounts(sessionId: number) {
  const files = await db
    .select({
      id: schema.bulkFiles.id,
      batchId: schema.bulkFiles.batchId,
      accountId: schema.bulkFiles.accountId,
      status: schema.bulkFiles.status,
    })
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, sessionId),
        inArray(schema.bulkFiles.status, ["staged", "held"]),
      ),
    );
  const batchIds = files
    .map((f) => f.batchId)
    .filter((id): id is number => id != null);
  const accountIds = [
    ...new Set(files.map((f) => f.accountId).filter((id): id is number => id != null)),
  ];
  if (batchIds.length === 0 || accountIds.length === 0) return;

  const pending = await pendingRowsForBatches(batchIds);
  const balanceDates = new Map<number, Set<string>>();
  for (const balance of pending.balances) {
    const dates = balanceDates.get(balance.accountId) ?? new Set<string>();
    dates.add(balance.date);
    balanceDates.set(balance.accountId, dates);
  }
  const results = await reconcileAccounts(pending, accountIds);

  for (const result of results) {
    // A file already held has made this account visible to the user. Do not
    // cascade that one file's absence into holding otherwise sound neighbours.
    if (files.some((f) => f.accountId === result.accountId && f.status === "held")) {
      continue;
    }
    const touchedDates = balanceDates.get(result.accountId) ?? new Set<string>();
    const mismatches = result.windows.filter(
      (window) => window.status === "mismatch" && touchedDates.has(window.toDate),
    );
    if (mismatches.length === 0) continue;

    const note = `${mismatches.length} statement period${
      mismatches.length === 1 ? " does" : "s do"
    } not reconcile after this folder was checked. Review this account before committing.`;
    await db
      .update(schema.bulkFiles)
      .set({ status: "held", note })
      .where(
        and(
          eq(schema.bulkFiles.sessionId, sessionId),
          eq(schema.bulkFiles.accountId, result.accountId),
          eq(schema.bulkFiles.status, "staged"),
        ),
      );
  }
}

async function commitStep(sessionId: number, state: BulkState) {
  const [next] = await db
    .select({
      fileId: schema.bulkFiles.id,
      batchId: schema.bulkFiles.batchId,
    })
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, sessionId),
        eq(schema.bulkFiles.status, "staged"),
      ),
    )
    .orderBy(asc(schema.bulkFiles.orderIndex))
    .limit(1);

  if (next) {
    if (!next.batchId) {
      await setFile(next.fileId, {
        status: "failed",
        note: "This statement lost its staged batch before it could be committed.",
      });
      return;
    }

    const batch = await db.query.importBatches.findFirst({
      where: eq(schema.importBatches.id, next.batchId),
    });
    if (!batch) {
      await setFile(next.fileId, {
        status: "failed",
        note: "This statement lost its staged batch before it could be committed.",
      });
      return;
    }

    let stats: CommitStats;
    if (batch.status === "committed") {
      // A force-quit can land after commitBatch's transaction but before the
      // run records that the file moved on. The batch's own committed stats are
      // the durable receipt: use them to finish that bookkeeping without
      // inserting the statement a second time.
      stats = committedBatchStats(batch.statsJson);
    } else if (batch.status === "review") {
      // One statement is one browser-driven step. In particular, do not call
      // commitSession here: on a Turso replica it turns a large folder into one
      // request containing thousands of serial remote writes, monopolizing the
      // shared client until the whole folder is finished.
      stats = await commitBatch(batch.id, { linkTransfers: false });
    } else {
      await setFile(next.fileId, {
        status: "failed",
        note: `This statement's staged batch is unexpectedly ${batch.status}.`,
      });
      return;
    }

    await recordCommittedFile(sessionId, next.fileId, state, stats);
    return;
  }

  // Pair only after every statement is present. Opposite transfer legs often
  // live in different files, and linking them per-file would miss the later
  // one. This is a step of its own, after the last commit response has returned.
  const transfersLinked = await autoLinkTransfers();
  const accountsLinked = await autoLinkAccountTransfers();
  await saveBulkState(sessionId, {
    ...state,
    phase: "categorize",
    stats: {
      ...state.stats,
      transfersLinked: state.stats.transfersLinked + transfersLinked,
      accountsLinked: state.stats.accountsLinked + accountsLinked,
    },
  });
}

/** The counters commitBatch persisted before a force-quit interrupted the run. */
function committedBatchStats(json: string | null): CommitStats {
  const empty: CommitStats = {
    inserted: 0,
    balancesRecorded: 0,
    skipped: 0,
    autoCategorized: 0,
    transfersLinked: 0,
    accountsLinked: 0,
  };
  if (!json) return empty;
  try {
    const saved = JSON.parse(json) as Partial<Record<keyof CommitStats, unknown>>;
    return Object.fromEntries(
      Object.entries(empty).map(([key, fallback]) => {
        const value = saved[key as keyof CommitStats];
        return [key, typeof value === "number" && Number.isFinite(value) ? value : fallback];
      }),
    ) as unknown as CommitStats;
  } catch {
    return empty;
  }
}

/**
 * Close the crash window between a batch commit and the bulk run's bookkeeping.
 * If the process stops before this transaction, the still-staged file is
 * repaired from the committed batch on Resume; if it stops after, both the file
 * and its totals have advanced together.
 */
async function recordCommittedFile(
  sessionId: number,
  fileId: number,
  state: BulkState,
  committed: CommitStats,
) {
  // Pause can be posted while the statement transaction is in flight. Merge
  // into the latest state so finishing this file never silently resumes a run
  // the user just paused.
  const latest = (await loadBulkState(sessionId)) ?? state;
  const next: BulkState = {
    ...latest,
    stats: {
      ...latest.stats,
      inserted: latest.stats.inserted + committed.inserted,
      balancesRecorded: latest.stats.balancesRecorded + committed.balancesRecorded,
    },
  };
  await db.transaction(async (tx) => {
    await tx
      .update(schema.bulkFiles)
      .set({ status: "committed" })
      .where(
        and(
          eq(schema.bulkFiles.id, fileId),
          eq(schema.bulkFiles.sessionId, sessionId),
          eq(schema.bulkFiles.status, "staged"),
        ),
      )
      .run();
    await tx
      .update(schema.importSessions)
      .set({ bulkStateJson: JSON.stringify(next) })
      .where(eq(schema.importSessions.id, sessionId))
      .run();
  });
}

async function categorizeStep(sessionId: number, state: BulkState) {
  let ids = state.categorizeIds;
  if (ids == null) {
    const batches = await db
      .select({ id: schema.importBatches.id })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.sessionId, sessionId));
    const batchIds = batches.map((b) => b.id);
    const rows = batchIds.length
      ? await db
          .select({ id: schema.transactions.id })
          .from(schema.transactions)
          .where(
            and(
              inArray(schema.transactions.importBatchId, batchIds),
              isNull(schema.transactions.categoryId),
            ),
          )
      : [];
    ids = rows.map((r) => r.id);
    await saveBulkState(sessionId, { ...state, categorizeIds: ids });
    state = { ...state, categorizeIds: ids };
  }

  const chunk = ids.slice(state.categorizeDone, state.categorizeDone + AI_BATCH_SIZE);
  if (chunk.length === 0) {
    await finishRun(sessionId, state);
    return;
  }

  let categorized = state.stats.categorized;
  try {
    const stats = await categorizeTransactions(chunk);
    categorized += stats.fromMemory + stats.fromAi + stats.fromRule + stats.accountsLinked;
  } catch (err) {
    // A dead AI key or a rate limit should not lose the import that already
    // happened — the rows are in the ledger and can be categorized from the
    // register whenever. Stop the phase and let the run finish.
    if (!(err instanceof AiError)) throw err;
    await finishRun(sessionId, { ...state, categorizeDone: ids.length });
    return;
  }

  const done = state.categorizeDone + chunk.length;
  const next: BulkState = {
    ...state,
    categorizeDone: done,
    stats: { ...state.stats, categorized },
  };
  if (done >= ids.length) await finishRun(sessionId, next);
  else await saveBulkState(sessionId, next);
}

async function finishRun(sessionId: number, state: BulkState) {
  await saveBulkState(sessionId, { ...state, phase: "done" });
  await db
    .update(schema.bulkFiles)
    .set({ status: "categorized" })
    .where(
      and(
        eq(schema.bulkFiles.sessionId, sessionId),
        eq(schema.bulkFiles.status, "committed"),
      ),
    );
  // A run with statements still held is not finished with — the session stays
  // open so the reconcile screen can still commit them.
  const [{ open }] = await db
    .select({ open: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.bulkFiles)
    .where(
      and(
        eq(schema.bulkFiles.sessionId, sessionId),
        inArray(schema.bulkFiles.status, ["held", "needs_input", "queued", "identified"]),
      ),
    );
  if (open === 0) {
    await db
      .update(schema.importSessions)
      .set({ status: "committed", committedAt: sql`(unixepoch())` })
      .where(eq(schema.importSessions.id, sessionId));
  }
}

// --- answering questions -----------------------------------------------------

export type BulkAnswer =
  | { choice: "account"; accountId: number }
  | { choice: "create"; fields: ProposedAccount }
  | { choice: "skip" };

/**
 * Put a failed file back in the queue to be read again. A failure here is
 * usually one flaky AI response out of forty, so the fix is a second read, not
 * a second upload — which is why a failed read keeps its file on disk. A retry
 * after the run has moved on winds the phase back to scan: the later phases
 * are re-entrant over what is already recorded (commit skips committed
 * batches, categorize re-plans against what is still uncategorized) — the
 * same property Resume rests on.
 */
export async function retryBulkFile(fileId: number): Promise<string | null> {
  const file = await db.query.bulkFiles.findFirst({
    where: eq(schema.bulkFiles.id, fileId),
  });
  if (!file) return "That file is no longer part of this run.";
  if (file.status !== "failed") return null;
  if (!readUpload(file.id, "bulk")) {
    return "The uploaded file is no longer on disk — run the folder again to pick this statement up.";
  }
  await setFile(file.id, { status: "queued", note: null });
  const state = await loadBulkState(file.sessionId);
  if (state && state.phase !== "scan") {
    await saveBulkState(file.sessionId, {
      ...state,
      phase: "scan",
      categorizeIds: null,
      categorizeDone: 0,
    });
  }
  return null;
}

/**
 * Apply an answer and put the file back in the queue. Answering never does the
 * work itself — it only unblocks the file, so the driver picks it up on its
 * next step exactly as if it had never stopped.
 */
export async function answerBulkQuestion(
  fileId: number,
  answer: BulkAnswer,
): Promise<string | null> {
  const file = await db.query.bulkFiles.findFirst({
    where: eq(schema.bulkFiles.id, fileId),
  });
  if (!file) return "That file is no longer part of this run.";
  if (file.status !== "needs_input") return null;

  if (answer.choice === "skip") {
    deleteUpload(file.id, "bulk");
    await setFile(file.id, {
      status: "skipped",
      questionJson: null,
      note: "Skipped.",
    });
    return null;
  }

  if (answer.choice === "account") {
    const account = await db.query.accounts.findFirst({
      where: eq(schema.accounts.id, answer.accountId),
    });
    if (!account) return "That account no longer exists.";
    await setFile(file.id, {
      status: "identified",
      accountId: account.id,
      accountAssignment: "Chosen by hand",
      questionJson: null,
    });
    return null;
  }

  const fields = answer.fields;
  if (!fields.name.trim() || !fields.institution.trim()) {
    return "The account needs a name and an institution.";
  }
  if (!isAccountType(fields.accountType)) return "Pick an account type.";
  if (fields.lastFour && !/^\d{4}$/.test(fields.lastFour)) {
    return "Last four digits must be exactly four numbers.";
  }
  const { account, created } = await findOrCreateAccount({
    name: fields.name.trim(),
    institution: fields.institution.trim(),
    accountType: fields.accountType,
    kind: resolveAccountKind(fields.accountType, fields.kind),
    lastFour: fields.lastFour || null,
  });
  await setFile(file.id, {
    status: "identified",
    accountId: account.id,
    accountAssignment: created
      ? `Created from this statement — ${accountLabel(account)}`
      : "Chosen by hand",
    questionJson: null,
  });
  if (created) {
    const state = await loadBulkState(file.sessionId);
    if (state) {
      await saveBulkState(file.sessionId, {
        ...state,
        stats: { ...state.stats, accountsCreated: state.stats.accountsCreated + 1 },
      });
    }
  }
  return null;
}
