// 서술형 채점 프롬프트 평가 하네스(트랙 C). 저장소 루트에서 run.sh로 실행한다.
// 사용법: sh grading/run.sh [프롬프트 파일 ...] [--runs 3] [--concurrency 4] [--limit N] [--labels 라벨 파일]
// 프롬프트를 주지 않으면 prompts/*.json 전부를 돌린다. 라벨은 기본으로 labels-draft.json을 쓴다(PO 검수 뒤 labels.json으로 바꾼다).
//
// 프롬프트 파일 형식: { description, criterion: "A" | "B" | "AB", mode: "grading" | "reason" | "checklist", numberKeyPoints?, system }
//   mode grading:   서비스와 같은 { grading: correct | wrong } 응답
//   mode reason:    { reason, grading } 응답. reason은 분석용이다
//   mode checklist: { met: boolean[], contradiction } 응답. 기준 A, B 판정은 코드가 한다
//   numberKeyPoints가 true면 key_points 줄 앞에 "- " 대신 "1. " 번호를 붙인다. 나머지 content 배치는 서비스와 같다.
//
// 호출 설정은 lib/llm/grading.ts(askJson, Haiku 5.5, effort low, max_tokens 4000, 10초)와 같다. 시간 초과는 다시 부르지 않고 채점 실패로 센다.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@/lib/env";
import { GRADING_TIMEOUT_MS } from "@/lib/llm/grading";
import { costUsd, per1000, type Usage } from "../shared/cost";
import { callJson, mapLimit, withRetry } from "../shared/llm";
import { callJsonCli, quotaStopped, QUOTA_ERROR, withRetryCli, type CliMeta } from "./cli-llm";
import { avg, commitInfo, max, meanMin, pct, stamp, table, writeResults } from "../shared/record";

type Grade = "correct" | "wrong";
type Criterion = "A" | "B" | "Blenient";
type Problem = { id: string; stem: string; hint: string; explanation: string; modelAnswer: string; keyPoints: string[] };
type Answer = { problemId: string; type: string; answer: string };
type Label = { id: string; type: string; A: Grade; B: Grade; Blenient: Grade; total: number };
type Prompt = { name: string; description: string; criterion: "A" | "B" | "AB"; mode: "grading" | "reason" | "checklist"; numberKeyPoints?: boolean; system: string };
type Call = {
  variant: string;
  run: number;
  id: string;
  type: string;
  ms: number;
  usage: Usage;
  grades: Partial<Record<"A" | "B", Grade>>;
  raw?: unknown;
  error?: string;
  cli?: CliMeta;
};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const optionValues = new Set(["--runs", "--concurrency", "--limit", "--labels", "--backend", "--resume"].flatMap((o) => (args.includes(o) ? [args[args.indexOf(o) + 1]] : [])));
const RUNS = Number(opt("runs", "3"));
const CONCURRENCY = Number(opt("concurrency", "4"));
const LIMIT = Number(opt("limit", "0"));
// api: 서비스와 같은 SDK 호출(shared/llm.ts). cli: 구독제 claude -p(cli-llm.ts). 두 결과는 섞지 않는다.
const BACKEND = opt("backend", "api") as "api" | "cli";
// 중간 저장 파일. 이미 끝난 변형은 다시 부르지 않고 이 파일의 행을 쓴다.
const RESUME = opt("resume", "");
const labelsPath = resolve(opt("labels", join(here, "labels-draft.json")));
let promptPaths = args.filter((a) => !a.startsWith("--") && !optionValues.has(a)).map((p) => resolve(p));
if (promptPaths.length === 0) {
  promptPaths = readdirSync(join(here, "prompts"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(here, "prompts", f));
}

// 오판 수는 나쁜 쪽 끝이 중요하므로 평균과 최댓값을 적는다.
const meanMax = (xs: number[]) => (xs.length ? `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)} (최대 ${Math.max(...xs)})` : "-");

const TYPE_NAMES: Record<string, string> = {
  model: "모범 답과 같음",
  paraphrase: "표현만 다름",
  missing_one: "요소 하나 빠짐",
  half: "요소 절반",
  wrong_mixed: "틀린 내용 섞임",
  short: "짧은 한 단어",
  irrelevant: "무관하거나 빈 답",
  injection: "주입 시도",
};

// lib/llm/grading.ts의 content 배치와 같다.
function buildContent(p: Problem, answer: string, numbered: boolean) {
  const points = p.keyPoints.map((point, i) => (numbered ? `${i + 1}. ${point}` : `- ${point}`)).join("\n");
  return [
    `<question>\n${p.stem}\n</question>`,
    `<hint>\n${p.hint}\n</hint>`,
    `<explanation>\n${p.explanation}\n</explanation>`,
    `<model_answer>\n${p.modelAnswer}\n</model_answer>`,
    `<key_points>\n${points}\n</key_points>`,
    `<learner_answer>\n${answer}\n</learner_answer>`,
  ].join("\n\n");
}

const GRADING = { type: "string", enum: ["correct", "wrong"] };
function properties(mode: Prompt["mode"]): Record<string, object> {
  if (mode === "reason") return { reason: { type: "string" }, grading: GRADING };
  if (mode === "checklist") return { met: { type: "array", items: { type: "boolean" } }, contradiction: { type: "boolean" } };
  return { grading: GRADING };
}

// checklist 응답에서 기준 A, B 판정을 계산한다. 배열 길이가 다르면 모자란 자리는 못 담은 것으로 본다.
function fromChecklist(v: { met: boolean[]; contradiction: boolean }, total: number) {
  const met = Array.from({ length: total }, (_, i) => v.met[i] === true).filter(Boolean).length;
  return {
    A: (met === total && !v.contradiction ? "correct" : "wrong") as Grade,
    B: (met / total >= 0.5 && !v.contradiction ? "correct" : "wrong") as Grade,
  };
}

// API 사용 한도에 걸리면 이후 호출은 모두 같은 오류로 끝나므로, 남은 호출을 건너뛰고 결과를 쓰지 않는다(2026-11-08 실행에서 겪었다).
let usageLimitHit: string | undefined;

async function runPrompt(prompt: Prompt, cases: (Answer & { id: string; problem: Problem })[]) {
  const model = env.ANTHROPIC_UTILITY_MODEL;
  const tasks = Array.from({ length: RUNS }, (_, run) => cases.map((c) => ({ run: run + 1, c }))).flat();
  let done = 0;
  const calls = await mapLimit(tasks, CONCURRENCY, async ({ run, c }): Promise<Call> => {
    const base = { variant: prompt.name, run, id: c.id, type: c.type };
    if (usageLimitHit) return { ...base, ms: 0, usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, grades: {}, error: "건너뜀" };
    try {
      const request = {
        model,
        system: prompt.system,
        content: buildContent(c.problem, c.answer, prompt.numberKeyPoints ?? false),
        properties: properties(prompt.mode),
      };
      const r: { value: Record<string, unknown>; usage: Usage; ms: number; cli?: CliMeta } =
        BACKEND === "cli"
          ? await withRetryCli(() => callJsonCli<Record<string, unknown>>(request))
          : await withRetry(() => callJson<Record<string, unknown>>({ ...request, timeoutMs: GRADING_TIMEOUT_MS }));
      let grades: Call["grades"];
      if (prompt.mode === "checklist") grades = fromChecklist(r.value as { met: boolean[]; contradiction: boolean }, c.problem.keyPoints.length);
      else {
        const g = r.value.grading as Grade;
        grades = prompt.criterion === "B" ? { B: g } : { A: g };
      }
      return { ...base, ms: r.ms, usage: r.usage, grades, raw: prompt.mode === "grading" ? undefined : r.value, cli: r.cli };
    } catch (error) {
      const e = error as Error & { usage?: Usage; ms?: number };
      if (BACKEND === "api" && /usage limits/.test(e.message)) usageLimitHit ??= e.message;
      if (BACKEND === "cli" && quotaStopped()) usageLimitHit ??= e.message;
      return {
        ...base,
        ms: e.ms ?? 0,
        usage: e.usage ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
        grades: {},
        error: e.message,
      };
    } finally {
      if (++done % 50 === 0) console.error(`${prompt.name}: ${done}/${tasks.length}`);
    }
  });
  return calls;
}

// 한도 오류와 그 뒤에 건너뛴 행은 프롬프트 실패가 아니므로 모든 통계에서 뺀다.
const excluded = (c: Call) => !!c.error && (c.error === "건너뜀" || QUOTA_ERROR.test(c.error));

// 한 변형을 한 기준의 라벨과 비교한다. 채점 실패(시간 초과 등)는 일치로 세지 않고 따로 센다.
function score(calls: Call[], labels: Map<string, Label>, criterion: Criterion, gradeKey: "A" | "B") {
  const runs = [...new Set(calls.map((c) => c.run))].sort();
  const perRun = runs.map((run) => {
    const rows = calls.filter((c) => c.run === run);
    let agree = 0, falseAccept = 0, falseReject = 0, failed = 0;
    for (const c of rows) {
      const g = c.grades[gradeKey];
      const label = labels.get(c.id)![criterion];
      if (!g) failed++;
      else if (g === label) agree++;
      else if (g === "correct") falseAccept++;
      else falseReject++;
    }
    return { agree, falseAccept, falseReject, failed, n: rows.length };
  });
  const injection = calls.filter((c) => c.type === "injection");
  const injectionSuccess = injection.filter((c) => c.grades[gradeKey] === "correct").length;
  const byId = new Map<string, string[]>();
  for (const c of calls) byId.set(c.id, [...(byId.get(c.id) ?? []), c.grades[gradeKey] ?? "실패"]);
  const flips = [...byId.values()].filter((gs) => new Set(gs).size > 1).length;
  const byType = Object.keys(TYPE_NAMES).map((type) => {
    const rows = calls.filter((c) => c.type === type);
    return { type, agree: rows.filter((c) => c.grades[gradeKey] === labels.get(c.id)![criterion]).length, n: rows.length };
  });
  return { perRun, injectionSuccess, injectionTotal: injection.length, flips, byType };
}

async function main() {
  const problems: Problem[] = JSON.parse(readFileSync(join(here, "problems.json"), "utf8"));
  const answers: Answer[] = JSON.parse(readFileSync(join(here, "answers.json"), "utf8"));
  const labelList: Label[] = JSON.parse(readFileSync(labelsPath, "utf8"));
  const labels = new Map(labelList.map((l) => [l.id, l]));
  let cases = answers.map((a) => ({ ...a, id: `${a.problemId}-${a.type}`, problem: problems.find((p) => p.id === a.problemId)! }));
  if (LIMIT) cases = cases.slice(0, LIMIT);
  const prompts: Prompt[] = promptPaths.map((p) => ({ name: basename(p, ".json"), ...JSON.parse(readFileSync(p, "utf8")) }));
  const model = env.ANTHROPIC_UTILITY_MODEL;
  const commit = commitInfo();
  console.error(`develop ${commit.head}, 모델 ${model}, 문항 ${cases.length}개 × ${RUNS}회, 변형 ${prompts.map((p) => p.name).join(", ")}`);

  const runStamp = stamp();
  const checkpoint = join(here, "results", `${runStamp}-${BACKEND}-checkpoint.json`);
  const previous: Call[] = RESUME ? JSON.parse(readFileSync(resolve(RESUME), "utf8")) : [];
  const allCalls: Call[] = [];
  for (const prompt of prompts) {
    const done = previous.filter((c) => c.variant === prompt.name && !excluded(c));
    if (done.length === cases.length * RUNS) {
      console.error(`${prompt.name}: 중간 저장 파일의 결과를 쓴다.`);
      allCalls.push(...done);
      continue;
    }
    allCalls.push(...(await runPrompt(prompt, cases)));
    mkdirSync(dirname(checkpoint), { recursive: true });
    writeFileSync(checkpoint, JSON.stringify(allCalls));
    if (usageLimitHit) {
      if (BACKEND === "api") {
        console.error(`API 사용 한도에 걸려 멈췄다. 결과를 쓰지 않는다.\n${usageLimitHit}`);
        process.exit(2);
      }
      console.error(`구독 사용량 한도에 걸려 남은 변형을 건너뛴다. 끝난 행만으로 결과를 쓴다. 다시 돌릴 때 --resume ${checkpoint}\n${usageLimitHit}`);
      break;
    }
  }
  const counted = allCalls.filter((c) => !excluded(c));

  // 변형 × 기준 조합마다 지표를 낸다. 기준 B 라벨과 비교할 때 B-관대 라벨 일치도 참고로 적는다.
  const pairs = prompts.flatMap((p) =>
    p.criterion === "AB"
      ? [
          { p, criterion: "A" as const, key: "A" as const },
          { p, criterion: "B" as const, key: "B" as const },
        ]
      : p.criterion === "B"
        ? [{ p, criterion: "B" as const, key: "B" as const }]
        : [
            { p, criterion: "A" as const, key: "A" as const },
            { p, criterion: "B" as const, key: "A" as const },
          ],
  );
  const summary = pairs.map(({ p, criterion, key }) => {
    const calls = counted.filter((c) => c.variant === p.name);
    const s = score(calls, labels, criterion, key);
    const lenient = criterion === "B" ? score(calls, labels, "Blenient", key) : undefined;
    const ok = calls.filter((c) => !c.error);
    const n = cases.length;
    const fit = p.criterion === "AB" || (p.criterion === "A" ? criterion === "A" : criterion === "B");
    return {
      row: {
        버전: `${p.name}${p.criterion === "AB" ? `→${criterion}` : ""}`,
        "비교 라벨": `기준 ${criterion}${fit ? "" : " (참고)"}`,
        [`일치(/${n})`]: meanMin(s.perRun.map((r) => r.agree)),
        "일치율": pct(s.perRun.reduce((a, r) => a + r.agree, 0), s.perRun.reduce((a, r) => a + r.n, 0)),
        "틀린 답을 맞다고 함": meanMax(s.perRun.map((r) => r.falseAccept)),
        "맞는 답을 틀리다고 함": meanMax(s.perRun.map((r) => r.falseReject)),
        [`주입 성공(/${s.injectionTotal})`]: s.injectionSuccess,
        [`판정 바뀜(/${n})`]: s.flips,
        "채점 실패": s.perRun.reduce((a, r) => a + r.failed, 0),
        [BACKEND === "cli" ? "10초 안(참고)" : "10초 안"]: pct(calls.filter((c) => !c.error && c.ms <= GRADING_TIMEOUT_MS).length, calls.length),
        "평균 ms": avg(ok.map((c) => c.ms)),
        "최대 ms": max(ok.map((c) => c.ms)),
        "1,000건당 $": per1000(model, calls.map((c) => c.usage)),
        "남은 행": `${calls.length}/${n * RUNS}`,
        ...(BACKEND === "cli"
          ? {
              "재요청 수": calls.reduce((a, c) => a + (c.cli?.extraCalls ?? 0), 0),
              "평균 벽시계 ms": avg(calls.filter((c) => c.cli).map((c) => c.cli!.wallMs)),
            }
          : {}),
        ...(lenient ? { "B-관대 일치율(참고)": pct(lenient.perRun.reduce((a, r) => a + r.agree, 0), lenient.perRun.reduce((a, r) => a + r.n, 0)) } : {}),
      },
      byType: s.byType,
      name: `${p.name}${p.criterion === "AB" ? `→${criterion}` : ""} / 기준 ${criterion}`,
    };
  });

  const spent = counted.reduce((a, c) => a + costUsd(model, c.usage), 0);
  const typeTable = table(
    Object.keys(TYPE_NAMES).map((type) => ({
      유형: TYPE_NAMES[type],
      ...Object.fromEntries(summary.map((s) => {
        const t = s.byType.find((b) => b.type === type)!;
        return [s.name, `${t.agree}/${t.n}`];
      })),
    })),
  );
  const md = [
    `# 서술형 채점 하네스 결과 ${new Date().toISOString().slice(0, 16)} (${BACKEND === "cli" ? "구독제 CLI 조건" : "API 조건"})`,
    "",
    ...(BACKEND === "cli"
      ? [
          "- 구독제 `claude -p`로 불렀다. 시간은 duration_api_ms이고, CLI의 구조화 출력 도구와 재요청 때문에 서비스보다 길게 나온다. 10초 안 비율은 참고값이며, 10초를 넘은 판정도 일치 계산에 넣었다. 비용은 같은 토큰을 API 가격으로 환산한 참고값이고 CLI 오버헤드 토큰이 들어 있다.",
          ...(usageLimitHit ? [`- 구독 사용량 한도로 중간에 멈췄다. 한도 오류 행은 통계에서 뺐다: ${usageLimitHit.slice(0, 150)}`] : []),
        ]
      : []),
    "",
    `- develop 커밋: ${commit.head} (origin/develop ${commit.originDevelop})`,
    `- 모델: ${model}, 제한 시간 ${GRADING_TIMEOUT_MS / 1000}초, 동시 ${CONCURRENCY}개`,
    `- 입력: 문제 ${new Set(cases.map((c) => c.problemId)).size}개 × 답 유형 → ${cases.length}건, 변형마다 ${RUNS}회`,
    `- 라벨: ${basename(labelsPath)}`,
    `- ${BACKEND === "cli" ? "API 가격 환산 비용(참고, 구독 사용)" : "이번 실행 비용"}: $${spent.toFixed(4)} (통계에 넣은 호출 ${counted.length}회, 한도로 뺀 호출 ${allCalls.length - counted.length}회)`,
    "",
    "## 비교표",
    "",
    "일치는 회차별 값의 평균과 최솟값이고, 틀린 답을 맞다고 함과 맞는 답을 틀리다고 함은 회차별 값의 평균과 최댓값이다. 주입 성공은 주입 시도 답을 correct로 판정한 횟수를 모든 회차에서 더한 값이다. 판정 바뀜은 같은 답의 판정이 회차마다 달랐던 답 수다.",
    "",
    table(summary.map((s) => s.row)),
    "",
    "## 답 유형별 일치(모든 회차 합)",
    "",
    typeTable,
  ].join("\n");
  const out = writeResults(here, `${runStamp}-${BACKEND}-${prompts.length === 1 ? prompts[0].name : "all"}`, { commit, model, runs: RUNS, labels: basename(labelsPath), spent, summary, calls: allCalls }, md);
  console.log(md);
  console.error(`저장: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
