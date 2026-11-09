// 구독제(claude.ai 로그인)로 채점 모델을 부르는 경로다. API 워크스페이스 한도(2026-11-08)에 걸린 뒤 쓴다.
// 트랙 D의 quiz-generation/cli-llm.ts를 옮겨 채점에 맞게 고쳤다. `claude -p` 헤드리스 모드를 askJson과 최대한 같게 맞춘다.
//   같은 것: 모델, effort low, system 프롬프트(--system-prompt로 기본 프롬프트를 통째로 바꾼다), user content, JSON 스키마, 프롬프트 캐시 없음.
//   다른 것: 스키마 출력이 output_config가 아니라 CLI의 StructuredOutput 도구로 나온다. CLI가 도구 정의 등으로 입력 토큰을 더 쓰고,
//           출력을 다시 받으려고 모델을 한 번 더 부르는 경우(재요청)가 있다. 그래서 시간과 비용은 서비스보다 크게 나온다.
//   시간은 CLI가 알려 주는 duration_api_ms로 잰다. 서비스의 10초 제한은 참고값으로만 기록하고, 넘어도 판정은 버리지 않는다.
//   (트랙 D와 다른 점: D는 제한 시간을 넘으면 실패로 처리한다. 채점은 CLI 오버헤드로 10초에 가까워서 판정 품질을 따로 보려고 남긴다.)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "../shared/cost";
import type { CallError } from "../shared/llm";

// CLAUDE.md나 프로젝트 설정이 섞이지 않게 빈 폴더에서 실행한다.
const CWD = mkdtempSync(join(tmpdir(), "grading-cli-"));
// CLI가 멈춘 경우를 끊는 벽시계 제한이다. 시간 초과 판정과는 별개다.
const HARD_LIMIT_MS = 120_000;

type CliOutput = {
  is_error: boolean;
  subtype: string;
  result?: string;
  structured_output?: unknown;
  duration_api_ms: number;
  duration_ms: number;
  api_error_status?: number | null;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

// 구조화 출력은 보통 2턴(StructuredOutput 도구 호출과 그 결과)으로 끝난다. 3턴 이상이면 재요청이 있었던 것이다.
export type CliMeta = { numTurns: number; extraCalls: number; wallMs: number };
export type CliResult<T> = { value: T; usage: Usage; ms: number; cli: CliMeta };

// 구독 사용량 한도 오류다. 프롬프트 실패가 아니므로 통계에서 빼고, 연달아 나오면 남은 호출을 건너뛴다.
export const QUOTA_ERROR = /usage limits?|rate limit|limit reached|hit your limit|resets? (at|in)|5-hour|weekly limit|out of extra usage/i;
let quotaStreak = 0;
const QUOTA_STOP = 3;
export const quotaStopped = () => quotaStreak >= QUOTA_STOP;

const fail = (message: string, usage?: Usage, ms?: number, status?: number): CallError =>
  Object.assign(new Error(message), { usage, ms, status });

export async function callJsonCli<T = Record<string, unknown>>({
  model,
  system,
  content,
  properties,
  maxTokens = 4000,
  effort = "low",
}: {
  model: string;
  system: string;
  content: string;
  properties: Record<string, object>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}): Promise<CliResult<T>> {
  if (quotaStopped()) throw fail("구독 사용량 한도(usage limits)에 걸려 호출을 건너뛰었다.");
  const schema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  const args = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--system-prompt", system,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
  ];
  const env = { ...process.env, DISABLE_PROMPT_CACHING: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
  // API 키가 있으면 CLI가 키로 과금하므로 지워서 구독 로그인을 쓰게 한다.
  delete env.ANTHROPIC_API_KEY;
  const started = performance.now();
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(fail(`CLI가 ${HARD_LIMIT_MS / 1000}초 안에 끝나지 않았다.`, undefined, HARD_LIMIT_MS));
    }, HARD_LIMIT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (!out.trim()) reject(fail(`CLI 출력이 비어 있다: ${err.slice(0, 300)}`));
      else resolve(out);
    });
    child.stdin.end(content);
  });
  const wallMs = Math.round(performance.now() - started);
  let d: CliOutput;
  try {
    d = JSON.parse(raw) as CliOutput;
  } catch {
    throw fail(`CLI 출력이 JSON이 아니다: ${raw.slice(0, 300)}`);
  }
  const u = d.usage ?? {};
  const usage: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
  const ms = d.duration_api_ms;
  const cli: CliMeta = { numTurns: d.num_turns ?? 0, extraCalls: Math.max(0, (d.num_turns ?? 2) - 2), wallMs };
  if (d.is_error) {
    const status = d.api_error_status ?? undefined;
    if (QUOTA_ERROR.test(String(d.result ?? ""))) {
      quotaStreak++;
      throw fail(`구독 사용량 한도(usage limits): ${String(d.result ?? "").slice(0, 200)}`, usage, ms, 429);
    }
    throw fail(`CLI 오류(${d.subtype}${status ? `, ${status}` : ""}): ${String(d.result ?? "").slice(0, 300)}`, usage, ms, status);
  }
  quotaStreak = 0;
  if (d.structured_output === undefined || d.structured_output === null) throw fail("AI 응답에 구조화 출력이 없다.", usage, ms);
  return { value: d.structured_output as T, usage, ms, cli };
}

// 사용량 제한(429)이나 일시 오류(5xx, 출력 없음)는 쉬었다가 다시 부른다. 형식 오류는 다시 부르지 않는다.
// 한도 오류는 다른 트랙과 구독을 나눠 쓰므로 길게 쉰다.
export async function withRetryCli<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const e = error as CallError & { status?: number };
      const retryable = e.status === 429 || e.status === 529 || (e.status !== undefined && e.status >= 500) || /CLI 출력이 비어 있다/.test(e.message);
      if (!retryable || attempt >= tries || quotaStopped()) throw error;
      await new Promise((r) => setTimeout(r, (e.status === 429 ? 30_000 : 5000) * 2 ** (attempt - 1)));
    }
  }
}
