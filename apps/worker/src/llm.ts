import { z } from "zod";

export type LlmEnv = { OPENROUTER_API_KEY?: string; LLM_MODEL?: string };

export type LlmRequest<T> = {
  /** Names the call in logs and in recorded fixtures. */
  name: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
};

/** The only way ingest talks to a model. Tests and fixtures swap in a recorded one. */
export interface Llm {
  json<T>(req: LlmRequest<T>): Promise<T>;
}

const ResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });
const TIMEOUT_MS = 45_000;

/**
 * OpenRouter with JSON-schema output, zod validation and one retry. Logs model, latency and outcome only:
 * never the prompt, the response, or a validation message that could quote them.
 */
export class OpenRouterLlm implements Llm {
  constructor(private env: LlmEnv, private doFetch: typeof fetch = (i, init) => fetch(i, init)) {}

  async json<T>(req: LlmRequest<T>): Promise<T> {
    const { OPENROUTER_API_KEY: key, LLM_MODEL: model } = this.env;
    if (!key || !model) throw new Error("OPENROUTER_API_KEY and LLM_MODEL must be set");
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    let lastError = "unknown";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      let outcome = "ok";
      try {
        const res = await this.doFetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
            response_format: { type: "json_schema", json_schema: { name: req.name, strict: true, schema: jsonSchema } },
            provider: { require_parameters: true },
          }),
        });
        if (!res.ok) {
          // OpenRouter's error body describes the problem (bad model id, no provider for a parameter); it never echoes the prompt.
          const detail = ((await res.json().catch(() => null)) as { error?: { message?: unknown } } | null)?.error?.message;
          throw new Error(`OpenRouter returned ${res.status}${typeof detail === "string" ? `: ${detail.slice(0, 160)}` : ""}`);
        }
        const content = ResponseSchema.parse(await res.json()).choices[0]!.message.content;
        if (!content) throw new Error("empty model response");
        const parsed = req.schema.safeParse(JSON.parse(content));
        if (!parsed.success) throw new Error("model output did not match the schema");
        return parsed.data;
      } catch (e) {
        outcome = "failed";
        lastError = e instanceof Error ? e.message.slice(0, 220) : "unknown";
      } finally {
        console.log(JSON.stringify({ llm: req.name, model, attempt, ms: Date.now() - started, outcome }));
      }
    }
    throw new Error(`LLM call ${req.name} failed: ${lastError}`);
  }
}
