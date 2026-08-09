import { z } from "zod";

export class AiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AiError";
  }
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatJSONOptions<T> {
  model?: string;
  system: string;
  user: string | ContentPart[];
  schema: z.ZodType<T>;
  schemaName: string;
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new AiError(
      "OPENROUTER_API_KEY is not set — add it to .env to use AI features.",
    );
  }
  return key;
}

/**
 * A statement page can take a minute to come back, so the ceiling is generous —
 * but there must be one. `fetch` waits forever on a connection that stalls
 * without closing, and extraction now issues a request per chunk: one stalled
 * socket would otherwise hang the whole import with nothing to show for it.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS ?? 180_000);
const MAX_ATTEMPTS = 3;
/** Statuses worth another go: rate limiting and the transient upstream faults. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function requestOnce(body: unknown): Promise<string> {
  let res: Response | undefined;
  let lastFailure = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout or a dropped connection — nothing was returned to judge, so
      // the request is simply worth repeating.
      lastFailure =
        err instanceof Error && err.name === "TimeoutError"
          ? `timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
          : String(err instanceof Error ? err.message : err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw new AiError(
        `OpenRouter request failed after ${MAX_ATTEMPTS} attempts (${lastFailure}).`,
      );
    }

    if (res.ok) break;

    const text = await res.text().catch(() => "");
    lastFailure = `${res.status}: ${text.slice(0, 500)}`;
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      // Honour Retry-After when the server sets it, else back off exponentially.
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 30) * 1000
          : 1000 * 2 ** (attempt - 1),
      );
      res = undefined;
      continue;
    }
    throw new AiError(`OpenRouter request failed (${lastFailure})`);
  }

  if (!res) throw new AiError(`OpenRouter request failed (${lastFailure})`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new AiError(`OpenRouter error: ${json.error.message}`);
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new AiError("OpenRouter returned an empty response");
  return content;
}

function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  return (fenced ? fenced[1] : content).trim();
}

/**
 * Call OpenRouter chat completions with a strict JSON schema response format,
 * validate with zod, and retry once with the validation error appended.
 */
export async function chatJSON<T>({
  model,
  system,
  user,
  schema,
  schemaName,
}: ChatJSONOptions<T>): Promise<T> {
  const resolvedModel = model ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
  const jsonSchema = z.toJSONSchema(schema);
  const messages: { role: string; content: string | ContentPart[] }[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const body = {
    model: resolvedModel,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema: jsonSchema },
    },
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await requestOnce(
      attempt === 0
        ? body
        : {
            ...body,
            messages: [
              ...messages,
              {
                role: "user",
                content: `Your previous response failed validation: ${String(
                  lastError,
                )}. Respond again with ONLY valid JSON matching the schema.`,
              },
            ],
          },
    );
    try {
      return schema.parse(JSON.parse(extractJson(content)));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new AiError(`AI response failed validation after retry: ${lastError}`);
}

export function pdfModel(): string {
  return process.env.OPENROUTER_MODEL_PDF ?? process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash";
}
