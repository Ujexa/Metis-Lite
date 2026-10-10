export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };
export type MessageContent = string | Array<TextContentPart | ImageContentPart>;
export type OpenRouterMessage = { role: "system" | "user"; content: MessageContent };

type ResponsePart = { type?: string; text?: string };
type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | ResponsePart[] | null;
      refusal?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: number | string };
};

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 120_000;

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_500;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

class OpenRouterRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

class OpenRouterTransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "OpenRouterTransientError";
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), RETRY_AFTER_CAP_MS) : undefined;
}

export function backoffDelayMs(attempt: number, retryAfterMs?: number, random = Math.random): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2)); // "equal jitter"
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("The AI request was cancelled.")); return; }
    const timer = globalThis.setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { globalThis.clearTimeout(timer); reject(new Error("The AI request was cancelled.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientStatus(status: number | undefined): boolean {
  return status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("The AI returned an invalid structured result.");
    const parsed: unknown = JSON.parse(normalized.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The AI returned an invalid structured result.");
    return parsed as Record<string, unknown>;
  }
}

function extractContent(payload: OpenRouterResponse): { content: string; finishReason: string; refusal: string } {
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const raw = message?.content;
  const content = Array.isArray(raw)
    ? raw.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("\n")
    : typeof raw === "string" ? raw : "";
  return {
    content,
    finishReason: choice?.finish_reason ?? "",
    refusal: cleanText(message?.refusal, 400),
  };
}

export type OpenRouterCallOptions = { webSearch?: boolean; maxCompletionTokens?: number; signal?: AbortSignal; onRetry?: (message: string) => void };

function buildBody(model: string, messages: OpenRouterMessage[], responseFormat?: Record<string, unknown>, fallbackJsonMode = false, compatibilityMode = false, options: OpenRouterCallOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.1,
    max_completion_tokens: options.maxCompletionTokens ?? 32_000,
    provider: compatibilityMode ? { allow_fallbacks: true } : { require_parameters: true, allow_fallbacks: true },
  };
  if (options.webSearch) {
    body.tools = [{ type: "openrouter:web_search", parameters: { max_results: 5, max_total_results: 10 } }];
  }
  if (responseFormat && !fallbackJsonMode) {
    body.response_format = { type: "json_schema", json_schema: responseFormat };
  } else if (fallbackJsonMode) {
    body.response_format = { type: "json_object" };
  }

  if (!compatibilityMode && model.startsWith("openai/gpt-oss")) {
    // OpenRouter's current reasoning interface is a `reasoning` object.
    // Excluding reasoning keeps the final message channel available for the
    // structured JSON that Metis actually consumes.
    body.reasoning = { effort: "high", exclude: true };
  }
  return body;
}

async function requestOnce(apiKey: string, model: string, messages: OpenRouterMessage[], responseFormat: Record<string, unknown> | undefined, fallbackJsonMode: boolean, compatibilityMode = false, options: OpenRouterCallOptions = {}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort(); else external?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://metis.local",
        "X-Title": "Metis Lite",
      },
      body: JSON.stringify(buildBody(model.trim(), messages, responseFormat, fallbackJsonMode, compatibilityMode, options)),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as OpenRouterResponse;
    if (!response.ok) {
      const providerMessage = cleanText(payload.error?.message, 500);
      throw new OpenRouterRequestError(providerMessage || `AI request failed (${response.status}).`, response.status, parseRetryAfter(response.headers.get("retry-after")));
    }
    const { content, finishReason, refusal } = extractContent(payload);
    if (!content.trim()) {
      if (refusal) throw new Error(`The AI declined this request: ${refusal}`);
      throw new Error(`The AI returned no usable content${finishReason ? ` (finish reason: ${finishReason})` : ""}.`);
    }
    try {
      return parseJsonObject(content);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "The AI returned malformed structured data.");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (timedOut) throw new OpenRouterTransientError("The AI request timed out. Try a smaller source or retry once.");
      throw new Error("The AI request was cancelled.");
    }
    // fetch() rejects with a TypeError on network failure; treat that as transient.
    if (error instanceof TypeError) throw new OpenRouterTransientError(`Network error: ${error.message}`);
    throw error instanceof Error ? error : new Error("The AI request failed.");
  } finally {
    globalThis.clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

// Retries 429 / 5xx / timeouts / network errors with exponential backoff, honouring Retry-After.
// Non-transient errors (400/401/402/403/422, refusals, bad JSON) are surfaced immediately.
async function request(apiKey: string, model: string, messages: OpenRouterMessage[], responseFormat: Record<string, unknown> | undefined, fallbackJsonMode: boolean, compatibilityMode = false, options: OpenRouterCallOptions = {}): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await requestOnce(apiKey, model, messages, responseFormat, fallbackJsonMode, compatibilityMode, options);
    } catch (error) {
      const transient = error instanceof OpenRouterTransientError || (error instanceof OpenRouterRequestError && isTransientStatus(error.status));
      if (!transient || attempt >= MAX_ATTEMPTS || options.signal?.aborted) throw error;
      const retryAfterMs = error instanceof OpenRouterTransientError || error instanceof OpenRouterRequestError ? error.retryAfterMs : undefined;
      const delay = backoffDelayMs(attempt, retryAfterMs);
      options.onRetry?.(`Provider busy or unreachable; retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})…`);
      await sleep(delay, options.signal);
    }
  }
}

export async function callOpenRouterJson(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  responseFormat: Record<string, unknown>,
  options: OpenRouterCallOptions = {},
): Promise<Record<string, unknown>> {
  if (!apiKey.trim()) throw new Error("Add your OpenRouter API key to use the AI problem engine.");
  if (!model.trim()) throw new Error("Choose an AI model first.");

  // DeepSeek V3.2 does not currently support OpenRouter's response_format
  // parameter. Ask it for JSON in the prompt and parse/validate the result
  // locally instead of triggering a compatibility failure on every request.
  if (/^deepseek\/deepseek-v3\.2(?:$|[-:])/i.test(model.trim())) {
    return request(apiKey, model, messages, undefined, false, true, options);
  }

  try {
    return await request(apiKey, model, messages, responseFormat, false, false, options);
  } catch (firstError) {
    // Some providers expose a model but do not reliably honor native JSON
    // schema generation or every reasoning parameter. Retry once in a more
    // compatible JSON mode before surfacing the error. The response is still
    // parsed and validated by Metis.
    const message = firstError instanceof Error ? firstError.message : "";
    const status = firstError instanceof OpenRouterRequestError ? firstError.status : undefined;
    const shouldRetry = status === 400 || status === 422 || /no usable content|invalid structured|malformed structured|finish reason/i.test(message);
    if (!shouldRetry) throw firstError;
    return request(apiKey, model, messages, undefined, true, true, options);
  }
}
