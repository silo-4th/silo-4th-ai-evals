// 서비스와 같은 조건으로 모델을 부른다. 토큰 사용량과 시간을 받으려고 SDK를 직접 부른다.
// askJson(lib/llm/ask-json.ts)과 streamAnswer(lib/llm/answer.ts)의 설정이 바뀌면 여기도 맞춘다.
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/llm/client";
import type { Usage } from "./cost";

export type CallResult<T> = { value: T; usage: Usage; ms: number; stopReason: string | null };
export type CallError = Error & { usage?: Usage; ms?: number };

const toUsage = (u: Anthropic.Usage | Anthropic.MessageDeltaUsage | undefined): Usage => ({
  inputTokens: u?.input_tokens ?? 0,
  outputTokens: u?.output_tokens ?? 0,
  cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  cacheReadTokens: u?.cache_read_input_tokens ?? 0,
});

const fail = (message: string, usage: Usage | undefined, started: number): CallError =>
  Object.assign(new Error(message), { usage, ms: Math.round(performance.now() - started) });

// askJson과 같은 설정이다: max_tokens 4000, effort low, json_schema(required 전부, additionalProperties false).
// schema에 properties만 넘기면 askJson처럼 감싼다. 완성된 스키마를 넘기려면 fullSchema를 쓴다.
export async function callJson<T = Record<string, unknown>>({
  model,
  system,
  content,
  properties,
  fullSchema,
  timeoutMs,
  maxTokens = 4000,
  effort = "low",
}: {
  model: string;
  system: string | Anthropic.TextBlockParam[];
  content: string;
  properties?: Record<string, object>;
  fullSchema?: object;
  timeoutMs: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}): Promise<CallResult<T>> {
  const schema = fullSchema ?? {
    type: "object",
    properties,
    required: Object.keys(properties ?? {}),
    additionalProperties: false,
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`AI가 ${timeoutMs / 1000}초 안에 답하지 않았다.`)), timeoutMs);
  const started = performance.now();
  try {
    const response = await anthropic().messages.create(
      {
        model,
        max_tokens: maxTokens,
        output_config: { effort, format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content }],
      },
      { signal: abort.signal },
    );
    const usage = toUsage(response.usage);
    if (response.stop_reason !== "end_turn") throw fail(`AI 응답이 ${response.stop_reason}로 끝났다.`, usage, started);
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw fail("AI 응답이 JSON이 아니다.", usage, started);
    }
    return { value, usage, ms: Math.round(performance.now() - started), stopReason: response.stop_reason };
  } catch (error) {
    if (abort.signal.aborted) throw fail((abort.signal.reason as Error).message, undefined, started);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type StreamResult = CallResult<string> & { firstTextMs: number | null };

// streamAnswer와 같은 설정이다: 스트리밍, effort low, max_tokens 16000, 첫 글자 60초, 전체 240초.
// system 블록(단원 본문의 cache_control 포함)은 부르는 쪽에서 서비스와 같은 순서로 만든다.
export async function streamText({
  model,
  system,
  messages,
  maxTokens = 16000,
  effort = "low",
  firstTextTimeoutMs = 60_000,
  deadlineMs = 240_000,
}: {
  model: string;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  firstTextTimeoutMs?: number;
  deadlineMs?: number;
}): Promise<StreamResult> {
  const abort = new AbortController();
  const firstText = setTimeout(() => abort.abort(new Error(`AI가 ${firstTextTimeoutMs / 1000}초 안에 답을 시작하지 않았다.`)), firstTextTimeoutMs);
  const deadline = setTimeout(() => abort.abort(new Error(`AI가 ${deadlineMs / 1000}초 안에 답을 끝내지 않았다.`)), deadlineMs);
  const started = performance.now();
  let firstTextMs: number | null = null;
  try {
    const stream = anthropic().messages.stream(
      { model, max_tokens: maxTokens, output_config: { effort }, system, messages },
      { signal: abort.signal },
    );
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && firstTextMs === null) {
        clearTimeout(firstText);
        firstTextMs = Math.round(performance.now() - started);
      }
    }
    const response = await stream.finalMessage();
    const usage = toUsage(response.usage);
    if (response.stop_reason === "refusal") throw fail("AI가 답을 거절했다.", usage, started);
    if (response.stop_reason === "max_tokens" || response.stop_reason === "model_context_window_exceeded") {
      throw fail("AI 답이 길이 제한에서 끊겼다.", usage, started);
    }
    const value = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!value.trim()) throw fail("AI 답이 비어 있다.", usage, started);
    return { value, usage, ms: Math.round(performance.now() - started), firstTextMs, stopReason: response.stop_reason };
  } catch (error) {
    if (abort.signal.aborted) throw fail((abort.signal.reason as Error).message, undefined, started);
    throw error;
  } finally {
    clearTimeout(firstText);
    clearTimeout(deadline);
  }
}

// 동시에 limit개까지만 돌린다. 결과 순서는 입력 순서와 같다.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// 429/529/네트워크 오류는 잠시 쉬고 다시 부른다. 시간 초과와 형식 오류는 다시 부르지 않고 실패로 센다.
export async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === 429 || status === 529 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= tries) throw error;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  }
}
