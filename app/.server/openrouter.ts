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

async function requestOnce(body: unknown): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AiError(`OpenRouter request failed (${res.status}): ${text.slice(0, 500)}`);
  }
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
