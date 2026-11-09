// 구독제(claude.ai 로그인)로 모델을 부르는 경로다. API 워크스페이스 한도(2026-11-08, 12/1 해제)에 걸린 뒤 쓴다.
// ../quiz-generation/cli-llm.ts(트랙 D)를 답변용으로 고쳐 옮겼다. 트랙 D 파일과 shared/는 고치지 않는다.
//
// 서비스(streamAnswer)와 같은 것: 모델(Sonnet 5.5), effort low, 스트리밍, 지시문과 단원 본문과 과거 요약 문장, 이번 질문.
// 서비스와 다른 것:
//   - system 블록 3개를 줄바꿈 두 개로 이어 한 문자열로 넘긴다(--system-prompt). 블록 순서는 같다.
//   - 캐시: 서비스는 단원 블록에만 5분 cache_control을 건다. CLI는 system과 메시지 전체에 1시간 캐시를 스스로 건다.
//     usage의 cache 토큰을 그대로 기록한다. 비용은 같은 토큰을 API 가격으로 환산한 참고값이다(구독이라 실제 과금은 없다).
//   - CLI가 도구 정의 등을 더해 입력 토큰이 서비스보다 조금 많다.
//   - 앞 대화(history): CLI는 assistant 턴을 그대로 넣지 못한다(넣으면 앞 user 턴에 실제 답을 하나 더 만든다).
//     그래서 앞 질문을 같은 프롬프트로 실제로 답하게 한 뒤 이번 질문을 보낸다. 앞 답은 AI 초안이 아니라 그 버전이 직접 쓴 답이다.
//     시간과 토큰은 마지막 턴 것만 센다. 판정자에게는 실제 앞 답을 준다.
//   - 시간: CLI가 요청을 시작한 시점(status requesting)부터 첫 text_delta까지를 첫 글자 시간, 결과까지를 전체 시간으로 잰다.
//     CLI 프로세스 시작 시간은 뺀다. 서비스의 60초/240초 제한도 이 값으로 판정한다.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "../shared/cost";
import type { CallError } from "../shared/llm";

const CWD = mkdtempSync(join(tmpdir(), "answer-cli-"));
const HARD_LIMIT_MS = 300_000;

export const QUOTA_ERROR = /usage limits?|rate limit|limit reached|hit your limit|resets? (at|in)|5-hour|weekly limit|out of extra usage/i;
let quotaStreak = 0;
export const quotaStopped = () => quotaStreak >= 3;
// 마지막으로 받은 구독 사용률(5시간 창, 7일 창)이다. 로그에 찍어 한도에 가까워지는지 본다.
export const lastRate: { five?: number; seven?: number } = {};

const fail = (message: string, usage?: Usage, ms?: number, status?: number): CallError =>
  Object.assign(new Error(message), { usage, ms, status });

const BASE_ARGS = ["--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence"];

function runCli(args: string[], stdin: string, env: NodeJS.ProcessEnv): Promise<{ lines: { t: number; d: any }[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
    const lines: { t: number; d: any }[] = [];
    let buf = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(fail(`CLI가 ${HARD_LIMIT_MS / 1000}초 안에 끝나지 않았다.`, undefined, HARD_LIMIT_MS));
    }, HARD_LIMIT_MS);
    child.stdout.on("data", (chunk) => {
      const now = performance.now();
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          lines.push({ t: now, d: JSON.parse(line) });
        } catch {
          /* JSON이 아닌 줄은 버린다 */
        }
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (buf.trim()) {
        try {
          lines.push({ t: performance.now(), d: JSON.parse(buf.trim()) });
        } catch {
          /* 무시 */
        }
      }
      if (lines.length === 0) reject(fail(`CLI 출력이 비어 있다: ${err.slice(0, 300)}`));
      else resolve({ lines });
    });
    child.stdin.end(stdin);
  });
}

function cliEnv(maxTokens: number) {
  const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

const toUsage = (u: any): Usage => ({
  inputTokens: u?.input_tokens ?? 0,
  outputTokens: u?.output_tokens ?? 0,
  cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  cacheReadTokens: u?.cache_read_input_tokens ?? 0,
});

function noteRate(d: any) {
  const w = d?.rate_limit_info?.unifiedWindows;
  if (w) {
    lastRate.five = w.five_hour?.utilization;
    lastRate.seven = w.seven_day?.utilization;
  }
}

export type CliStreamResult = {
  value: string;
  usage: Usage;
  ms: number;
  firstTextMs: number | null;
  priorAnswers: string[];
};

// user 턴들을 차례로 보내고 마지막 턴의 답을 돌려준다. turns가 하나면 서비스의 단일 질문과 같다.
export async function streamTextCli({
  model,
  system,
  turns,
  maxTokens = 16000,
  firstTextTimeoutMs = 60_000,
  deadlineMs = 240_000,
}: {
  model: string;
  system: string;
  turns: string[];
  maxTokens?: number;
  firstTextTimeoutMs?: number;
  deadlineMs?: number;
}): Promise<CliStreamResult> {
  if (quotaStopped()) throw fail("구독 사용량 한도(usage limits)에 걸려 호출을 건너뛰었다.");
  const args = ["-p", "--model", model, "--effort", "low", "--system-prompt", system, ...BASE_ARGS, "--verbose", "--output-format", "stream-json", "--include-partial-messages"];
  let stdin: string;
  if (turns.length === 1) stdin = turns[0];
  else {
    args.push("--input-format", "stream-json");
    stdin = turns.map((t) => JSON.stringify({ type: "user", message: { role: "user", content: t } })).join("\n") + "\n";
  }
  const { lines } = await runCli(args, stdin, cliEnv(maxTokens));
  for (const { d } of lines) if (d.type === "rate_limit_event") noteRate(d);
  // 턴마다 status requesting → stream_event들 → assistant → result 순서로 나온다. result 기준으로 턴을 나눈다.
  const results = lines.filter((l) => l.d.type === "result");
  const last = results[results.length - 1]?.d;
  if (!last) throw fail("CLI 결과가 없다.");
  const priorAnswers = results.slice(0, -1).map((r) => String(r.d.result ?? ""));
  const lastStartIdx = results.length > 1 ? lines.indexOf(results[results.length - 2]) + 1 : 0;
  const turnLines = lines.slice(lastStartIdx);
  const reqStart = turnLines.find((l) => l.d.type === "system" && l.d.subtype === "status" && l.d.status === "requesting")?.t ?? turnLines[0].t;
  const firstText = turnLines.find((l) => l.d.type === "stream_event" && l.d.event?.type === "content_block_delta" && l.d.event?.delta?.type === "text_delta")?.t;
  const endT = results[results.length - 1].t;
  const usage = toUsage(last.usage);
  const ms = Math.round(endT - reqStart);
  const firstTextMs = firstText ? Math.round(firstText - reqStart) : null;
  if (last.is_error) {
    const msg = String(last.result ?? last.subtype);
    if (QUOTA_ERROR.test(msg)) {
      quotaStreak++;
      throw fail(`구독 사용량 한도(usage limits): ${msg.slice(0, 200)}`, usage, ms);
    }
    throw fail(`CLI 오류(${last.subtype}${last.api_error_status ? `, ${last.api_error_status}` : ""}): ${msg.slice(0, 300)}`, usage, ms, last.api_error_status ?? undefined);
  }
  quotaStreak = 0;
  if (firstTextMs !== null && firstTextMs > firstTextTimeoutMs) throw fail(`AI가 ${firstTextTimeoutMs / 1000}초 안에 답을 시작하지 않았다.`, usage, ms);
  if (ms > deadlineMs) throw fail(`AI가 ${deadlineMs / 1000}초 안에 답을 끝내지 않았다.`, usage, ms);
  if (last.stop_reason === "max_tokens") throw fail("AI 답이 길이 제한에서 끊겼다.", usage, ms);
  const value = String(last.result ?? "");
  if (!value.trim()) throw fail("AI 답이 비어 있다.", usage, ms);
  return { value, usage, ms, firstTextMs, priorAnswers };
}

// 판정용 JSON 호출이다. 트랙 D의 callJsonCli와 같은 방식(--json-schema, StructuredOutput)이다. 캐시는 CLI 기본값대로 둔다.
export async function callJsonCli<T>({
  model,
  system,
  content,
  fullSchema,
  timeoutMs,
  maxTokens = 8000,
}: {
  model: string;
  system: string;
  content: string;
  fullSchema: object;
  timeoutMs: number;
  maxTokens?: number;
}): Promise<{ value: T; usage: Usage; ms: number }> {
  if (quotaStopped()) throw fail("구독 사용량 한도(usage limits)에 걸려 호출을 건너뛰었다.");
  const args = ["-p", "--model", model, "--effort", "low", "--system-prompt", system, ...BASE_ARGS, "--verbose", "--output-format", "stream-json", "--json-schema", JSON.stringify(fullSchema)];
  const { lines } = await runCli(args, content, cliEnv(maxTokens));
  for (const { d } of lines) if (d.type === "rate_limit_event") noteRate(d);
  const d = lines.filter((l) => l.d.type === "result").pop()?.d;
  if (!d) throw fail("CLI 결과가 없다.");
  const usage = toUsage(d.usage);
  const ms = d.duration_api_ms ?? 0;
  if (d.is_error) {
    const msg = String(d.result ?? d.subtype);
    if (QUOTA_ERROR.test(msg)) {
      quotaStreak++;
      throw fail(`구독 사용량 한도(usage limits): ${msg.slice(0, 200)}`, usage, ms);
    }
    throw fail(`CLI 오류(${d.subtype}): ${msg.slice(0, 300)}`, usage, ms, d.api_error_status ?? undefined);
  }
  quotaStreak = 0;
  if (ms > timeoutMs) throw fail(`판정이 ${timeoutMs / 1000}초 안에 끝나지 않았다.`, usage, ms);
  if (d.structured_output == null) throw fail("판정 응답에 구조화 출력이 없다.", usage, ms);
  return { value: d.structured_output as T, usage, ms };
}

// 429, 5xx, 빈 출력은 쉬었다가 다시 부른다. 한도 오류는 조금 길게 쉬고 다시 부른다.
export async function withRetryCli<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const e = error as CallError & { status?: number };
      const quota = /usage limits/.test(e.message) && !/건너뛰었다/.test(e.message);
      const retryable = quota || e.status === 429 || e.status === 529 || (e.status !== undefined && e.status >= 500) || /CLI 출력이 비어 있다|CLI 결과가 없다/.test(e.message);
      if (!retryable || attempt >= tries) throw error;
      await new Promise((r) => setTimeout(r, (quota ? 30_000 : 5000) * 2 ** (attempt - 1)));
    }
  }
}
