// 퀴즈 생성 프롬프트 평가 하네스(트랙 D). 저장소 루트에서 run.sh로 실행한다.
// 사용법: sh run.sh [프롬프트 파일 ...] [--backend api|cli] [--runs 3] [--judge-only 결과.json] [--judge-concurrency 10] [--cases cases.json] [--only d01,d02] [--limit N] [--concurrency 4] [--no-judge] [--tag 이름]
// 프롬프트 파일을 여러 개 주면 같은 입력 세트로 차례로 돌려 비교표를 만든다. 주지 않으면 prompts/baseline.json을 쓴다.
//
// 프롬프트 파일 형식: { "name", "description"?, "system": string[], "formatRules": { mcq, blank, free } }
//   서비스처럼 system 문장들을 공백으로 잇고, 뒤에 형식 규칙을 공백 하나로 붙인다.
//
// 호출 설정과 content 조립은 lib/llm/quiz-generation.ts의 generateQuizProblem과 같다(askJson, effort low, max_tokens 4000, 30초).
// 그 파일의 스키마나 content 조립이 바뀌면 여기도 맞춘다.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "@/lib/db";
import { concept, unit } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { parseQuizProblem } from "@/lib/quiz-problem";
import { DEFAULT_QUIZ_PROBLEMS } from "@/lib/default-quiz-problems";
import { costUsd, emptyUsage, per1000, type Usage } from "../shared/cost";
import { judge, JUDGE_MODEL, type JudgeItem } from "../shared/judge";
import { callJson, mapLimit, withRetry, type CallError } from "../shared/llm";
import { callJsonCli, judgeCli, quotaStopped, withRetryCli } from "./cli-llm";
import { avg, commitInfo, max, meanMin, pct, stamp, table, writeResults } from "../shared/record";

type Format = "mcq" | "blank" | "free";
type ContextKind = "summaries" | "conversation" | "none";
type Case = { id: string; conceptId: string; format: Format; context: ContextKind; conversation?: string; tags?: string[] };
type CaseFile = {
  summaries: Record<string, string[]>;
  conversations: Record<string, { question: string; answer: string }>;
  cases: Case[];
};
// fewshot: 같은 형식의 등록 문제를 system 끝에 예시로 붙인다. 객관식은 서비스 기본 문제, 빈칸과 서술형은 fewshot-mocks.json 목업이다.
type Prompt = { name: string; description?: string; system: string[]; formatRules: Record<Format, string>; fewshot?: { count: number; intro: string } };
type Example = { id: string; conceptId: string; format: Format; stem: string; hint: string; explanation: string; answer: unknown };

type Auto = {
  parsed: boolean;
  formatRule: boolean;
  formatNote?: string;
  banned: string[];
  maxTableRows: number;
  tableOk: boolean;
  copiedLines?: string[];
};
export type Row = {
  run: number;
  caseId: string;
  conceptId: string;
  sectionTitle: string;
  format: Format;
  context: ContextKind;
  tags: string[];
  ms: number;
  usage: Usage;
  error?: string;
  output?: Record<string, unknown>;
  auto?: Auto;
  judge?: Record<string, JudgeItem>;
  judgeUsage?: Usage;
  judgeError?: string;
  cli?: { numTurns: number; extraCalls: number };
  examples?: string[];
};

// 서비스 상수 QUIZ_GENERATION_TIMEOUT_MS와 같다.
const TIMEOUT_MS = 30_000;
// 학습 화면을 가리키는 표현이다. HANDOFF의 목록("본문", "위 표", "아래 표", "앞에서")에 비슷한 표현을 더했다.
const BANNED = ["본문", "위 표", "아래 표", "앞에서", "위의 표", "아래의 표", "위 예제", "앞의 예제", "앞 예제", "이 단원", "단원에서", "학습 화면", "교재"];
const MAX_TABLE_ROWS = 5;
const FENCE = "`".repeat(3);

// lib/llm/quiz-generation.ts의 ANSWER_SCHEMAS와 같다.
const textList = { type: "array", items: { type: "string" } };
const strictObject = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ANSWER_SCHEMAS: Record<Format, object> = {
  mcq: strictObject({ choices: { type: "array", items: strictObject({ text: { type: "string" } }) }, answerIndex: { type: "integer" } }),
  blank: strictObject({ accepted: textList }),
  free: strictObject({ modelAnswer: { type: "string" }, keyPoints: textList }),
};

// lib/llm/quiz-generation.ts의 contextBlock과 같다. 맥락 없음은 서비스의 기본 문제 생성처럼 빈 요약 목록이다.
function contextBlock(c: Case, file: CaseFile, unitId: string) {
  if (c.context === "conversation") {
    const conv = file.conversations[c.conversation!];
    return `<conversation>\n<question>\n${conv.question}\n</question>\n<answer>\n${conv.answer}\n</answer>\n</conversation>`;
  }
  const summaries = c.context === "summaries" ? file.summaries[unitId] : [];
  return `<conversation_summaries>\n${summaries.map((s) => `<summary>\n${s}\n</summary>`).join("\n")}\n</conversation_summaries>`;
}

function buildContent(unitContent: string, conceptId: string, title: string, format: Format, ctx: string) {
  return [
    `<unit_content>\n${unitContent}\n</unit_content>`,
    `<target_section concept_id="${conceptId}">\n${title}\n</target_section>`,
    `<format>${format}</format>`,
    ctx,
  ].join("\n\n");
}

// 예시 풀. 같은 형식에서, 대상 절과 같은 절은 빼고, 같은 단원을 먼저 고른다(단원은 절 ID 앞 5글자, 예: s2-05).
let examplePool: Example[] | undefined;
function loadExamples(): Example[] {
  if (examplePool) return examplePool;
  const mcq = DEFAULT_QUIZ_PROBLEMS.filter((p) => p.format === "mcq").map((p, i) => ({ ...(p as unknown as Example), id: `default-${i}-${p.conceptId}` }));
  const mocks = JSON.parse(readFileSync(join(here, "fewshot-mocks.json"), "utf8")).mocks.filter((m: { check?: { pass: boolean } }) => m.check?.pass) as Example[];
  examplePool = [...mcq, ...mocks];
  return examplePool;
}
function pickExamples(format: Format, conceptId: string, count: number): Example[] {
  const unitOf = (id: string) => id.slice(0, 5);
  const seen = new Set<string>();
  const pool = loadExamples()
    .filter((e) => e.format === format && e.conceptId !== conceptId)
    .filter((e) => (seen.has(e.conceptId) ? false : (seen.add(e.conceptId), true)))
    .sort((a, b) => Number(unitOf(b.conceptId) === unitOf(conceptId)) - Number(unitOf(a.conceptId) === unitOf(conceptId)) || a.conceptId.localeCompare(b.conceptId));
  return pool.slice(0, count);
}
function examplesBlock(intro: string, examples: Example[]) {
  const body = examples
    .map((e) => `<example>\n${JSON.stringify({ stem: e.stem, hint: e.hint, explanation: e.explanation, answer: e.answer }, null, 2)}\n</example>`)
    .join("\n");
  return `${intro}\n<examples>\n${body}\n</examples>`;
}
// 예시를 베꼈는지 본다: 생성 stem의 코드 블록 줄 가운데 8글자 이상이고 숫자나 "|"가 든 줄이 예시 stem에 그대로 있으면 센다.
function copiedFrom(stem: string, examples: Example[]): string[] {
  const codeLines = (t: string) => [...t.matchAll(/```\w*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n")).map((l) => l.trim().replace(/\s+/g, " "));
  const exLines = new Set(examples.flatMap((e) => codeLines(e.stem)));
  return [...new Set(codeLines(stem).filter((l) => l.length >= 8 && /[0-9|]/.test(l) && !/^[-|+ ]+$/.test(l) && exLines.has(l)))];
}

// stem 안 표의 데이터 행 수를 센다. 코드 블록(SQL 주석으로 넣은 표 포함)에서는 "|"가 든 줄을 표 줄로 보고,
// 구분선과 머리글 한 줄을 뺀다. "||"(문자열 연결)가 든 줄은 SQL로 본다. 코드 블록 밖의 마크다운 표도 센다.
function tableRows(stem: string): number[] {
  const counts: number[] = [];
  const blocks = [...stem.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
  for (const [, , body] of blocks) {
    const lines = body.split("\n");
    const isSep = (l: string) => /^[\s|+:-]+$/.test(l.replace(/^\s*--\s?/, "")) && l.includes("--") && !/^\s*--\s*$/.test(l);
    // "|"가 없는 줄(표 이름, 빈 줄, SQL)에서 표를 끊는다. 한 코드 블록에 작은 표 두 개를 넣은 경우를 따로 센다.
    let run = 0;
    for (const l of [...lines, ""]) {
      if (isSep(l)) continue;
      if (l.includes("|") && !l.includes("||")) run++;
      else {
        if (run >= 2) counts.push(run - 1);
        run = 0;
      }
    }
  }
  const outside = stem.replace(/```[\s\S]*?```/g, "");
  let inTable = false;
  let rows = 0;
  for (const line of outside.split("\n")) {
    const t = line.trim();
    if (t.startsWith("|")) {
      if (/^\|[\s|:-]+\|$/.test(t)) {
        inTable = true;
        rows = 0;
      } else if (inTable) rows++;
    } else if (inTable) {
      counts.push(rows);
      inTable = false;
    }
  }
  if (inTable) counts.push(rows);
  return counts;
}

function visibleText(o: Record<string, unknown>): string {
  const a = (o.answer ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(a.choices) ? a.choices.map((c) => (c as { text?: string }).text ?? "").join("\n") : "";
  return [o.stem, o.hint, o.explanation, choices, a.modelAnswer, Array.isArray(a.keyPoints) ? a.keyPoints.join("\n") : ""].join("\n");
}

function autoCheck(output: Record<string, unknown>, format: Format): Auto {
  const parsed = parseQuizProblem({ ...output, format }) !== undefined;
  const a = (output.answer ?? {}) as Record<string, unknown>;
  const stem = typeof output.stem === "string" ? output.stem : "";
  let formatRule = true;
  let formatNote: string | undefined;
  if (format === "mcq") {
    const n = Array.isArray(a.choices) ? a.choices.length : 0;
    const idx = a.answerIndex as number;
    formatRule = n >= 2 && n <= 4 && Number.isInteger(idx) && idx >= 0 && idx < n;
    if (!formatRule) formatNote = `보기 ${n}개, answerIndex ${idx}`;
  } else if (format === "blank") {
    const marks = stem.match(/_{4,}/g) ?? [];
    formatRule = marks.length === 1 && marks[0] === "____";
    if (!formatRule) formatNote = `밑줄 자리 ${marks.length}개(${marks.join(", ")})`;
  } else {
    const kp = Array.isArray(a.keyPoints) ? a.keyPoints.filter((k) => typeof k === "string" && k.trim()) : [];
    formatRule = kp.length > 0;
    if (!formatRule) formatNote = "keyPoints 없음";
  }
  const text = visibleText(output);
  const banned = BANNED.filter((p) => text.includes(p));
  const rows = tableRows(stem);
  const maxTableRows = max(rows);
  return { parsed, formatRule, formatNote, banned, maxTableRows, tableOk: maxTableRows <= MAX_TABLE_ROWS };
}

// 사람과 판정자가 읽을 수 있게 문제를 글로 펼친다.
export function renderProblem(o: Record<string, unknown>, format: Format): string {
  const a = (o.answer ?? {}) as Record<string, unknown>;
  const lines = [`[문제]\n${o.stem}`];
  if (format === "mcq" && Array.isArray(a.choices)) {
    lines.push(
      "[보기]\n" +
        a.choices.map((c, i) => `${i + 1}. ${(c as { text?: string }).text}${i === a.answerIndex ? "  ← 정답으로 표시됨" : ""}`).join("\n"),
    );
  }
  if (format === "blank") lines.push(`[정답으로 인정하는 답(accepted)]\n${(a.accepted as string[] | undefined)?.join(" / ")}`);
  if (format === "free") {
    lines.push(`[모범 답]\n${a.modelAnswer}`);
    lines.push(`[채점 핵심 요소]\n${(a.keyPoints as string[] | undefined)?.map((k) => `- ${k}`).join("\n")}`);
  }
  lines.push(`[힌트]\n${o.hint}`, `[해설]\n${o.explanation}`);
  return lines.join("\n\n");
}

export const CRITERIA = [
  {
    key: "scope",
    question:
      "문제가 target_section 절의 내용을 묻는가? 단원의 다른 절이 주로 다루는 개념이 문제의 핵심이면 실패다. 절 내용을 묻는 데 필요한 기본 SQL을 쓰는 것은 괜찮다.",
  },
  {
    key: "answer_correct",
    question:
      "정답이 하나로 정해지고 실제로 맞는가? 객관식은 정답으로 표시된 보기만 맞고 나머지는 모두 틀려야 한다. 빈칸은 accepted의 답이 모두 맞고 빈칸에 들어갈 답이 사실상 하나로 정해져야 한다(같은 뜻의 다른 표기는 괜찮다). 서술형은 모범 답과 핵심 요소가 맞고 무엇을 써야 하는지 질문이 분명해야 한다. 문제 안의 표와 SQL이 있으면 결과를 직접 계산해 확인한다.",
  },
  {
    key: "self_contained",
    question:
      "문제(stem과 보기)만 보고 풀 수 있는가? 문제에 없는 데이터나 학습 화면의 표·예제를 알아야만 풀 수 있으면 실패다. SQLD 학습자가 알아야 하는 일반 지식(Oracle 기본 동작 등)은 써도 된다.",
  },
  { key: "hint_no_leak", question: "hint가 정답을 직접 말하거나 정답을 하나로 좁혀 주지 않고, 떠올릴 실마리만 주는가?" },
  { key: "explanation_correct", question: "explanation이 정답의 이유를 맞게 설명하는가? 틀린 계산, 틀린 문법 설명, 정답과 어긋나는 서술이 하나라도 있으면 실패다." },
  {
    key: "sqld_fit",
    question:
      "SQLD(SQL 개발자) 시험 범위와 난이도에 맞는가? 다른 시험(정보처리기사 등)의 범위이거나, 용어 뜻만 묻는 지나치게 쉬운 문제이거나, 시험 수준을 크게 넘는 지엽적 내용이면 실패다.",
  },
];
export const JUDGE_KEYS = CRITERIA.map((c) => c.key);

const JUDGE_TASK =
  "SQLD 학습 서비스가 단원 원문(unit_content)과 출제할 절(target_section)을 주고 AI에게 퀴즈 문제 하나를 만들게 했다. 학습자는 학습 화면 없이 문제만 본다. 대화 맥락(context)은 학습자가 헷갈린 지점을 짚는 데만 쓰고 출제 범위를 넓히면 안 된다. 만들어진 문제(generated_problem)를 기준마다 판정한다.";

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-judge") opts.noJudge = true;
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else files.push(a);
  }
  return { opts, files };
}

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { opts, files } = parseArgs(process.argv.slice(2));
  let runs = Number(opts.runs ?? 3);
  // 구독제(cli)는 다른 트랙과 같은 구독을 나눠 쓰므로 동시 호출을 3으로 묶는다(11/8 팀 리드 요청).
  const cliDefault = opts.backend === "cli" ? 3 : undefined;
  const concurrency = Number(opts.concurrency ?? cliDefault ?? 4);
  const caseFile: CaseFile = JSON.parse(readFileSync(resolve((opts.cases as string) ?? join(here, "cases.json")), "utf8"));
  let cases = caseFile.cases;
  if (opts.only) cases = cases.filter((c) => (opts.only as string).split(",").includes(c.id));
  if (opts.limit) cases = cases.slice(0, Number(opts.limit));
  const promptPaths = files.length ? files.map((f) => resolve(f)) : [join(here, "prompts", "baseline.json")];
  const prompts: Prompt[] = promptPaths.map((p) => ({ name: basename(p, ".json"), ...JSON.parse(readFileSync(p, "utf8")) }));

  const db = getDb();
  const units = await db.select().from(unit);
  const concepts = await db.select().from(concept);
  await db.$client.end();
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const unitById = new Map(units.map((u) => [u.id, u]));

  const model = env.ANTHROPIC_MODEL;
  // api: 서비스처럼 SDK로 부른다(API 키 과금). cli: 구독 로그인으로 `claude -p`를 부른다(cli-llm.ts 참고).
  const backend = (opts.backend as string) ?? "api";
  if (backend !== "api" && backend !== "cli") throw new Error(`--backend는 api 또는 cli다: ${backend}`);
  const gen = backend === "cli" ? callJsonCli : callJson;
  const retry = backend === "cli" ? withRetryCli : withRetry;
  const judgeFn = backend === "cli" ? judgeCli : judge;
  const commit = commitInfo();
  console.log(`호출 경로 ${backend}, 모델 ${model}, 판정 ${opts.noJudge ? "없음" : JUDGE_MODEL}, 입력 ${cases.length}건, ${runs}회, 프롬프트 ${prompts.length}개, 커밋 ${commit.head}`);

  let spend = 0;
  const results: { prompt: Prompt; rows: Row[] }[] = [];
  // 1단계: 생성. 응답 시간을 재는 단계라 동시 호출을 서비스 부하에 가깝게 낮게 둔다.
  const materials = new Map<Row, string>();
  const materialFor = (c: Case, output: Record<string, unknown>) => {
    const con = conceptById.get(c.conceptId)!;
    const u = unitById.get(con.unitId)!;
    const ctx = contextBlock(c, caseFile, u.id);
    return [
      `<unit_content>\n${u.content}\n</unit_content>`,
      `<target_section concept_id="${con.id}">\n${con.title}\n</target_section>`,
      `<format>${c.format}</format>`,
      `<context>\n${c.context === "none" ? "(맥락 없음)" : ctx}\n</context>`,
      `<generated_problem>\n${renderProblem(output, c.format)}\n</generated_problem>`,
    ].join("\n\n");
  };
  const failText = (row: Row) =>
    [
      row.error,
      row.auto && !row.auto.parsed && "모양 검사 실패",
      row.auto?.banned.length && `금지 표현 ${row.auto.banned.join(",")}`,
      row.auto && !row.auto.tableOk && `표 ${row.auto.maxTableRows}행`,
      row.judgeError && `판정 오류: ${row.judgeError.slice(0, 80)}`,
      ...JUDGE_KEYS.filter((k) => row.judge && !row.judge[k]?.pass),
    ].filter(Boolean);
  // 판정이 남은 행을 판정한다. 시간을 재지 않으므로 생성과 따로 돌린다. 판정한 행은 materials에서 지운다.
  const judgeConcurrency = Number(opts["judge-concurrency"] ?? cliDefault ?? 10);
  const judgePending = async () => {
    if (opts.noJudge || materials.size === 0) return;
    const todo = [...materials.keys()];
    console.log(`== 판정 ${todo.length}건, 동시 ${judgeConcurrency}`);
    await mapLimit(todo, judgeConcurrency, async (row) => {
      try {
        const j = await judgeFn({ task: JUDGE_TASK, criteria: CRITERIA, material: materials.get(row)! });
        row.judge = j.items;
        row.judgeUsage = j.usage;
        spend += costUsd(JUDGE_MODEL, j.usage);
      } catch (error) {
        row.judgeError = (error as Error).message;
      }
      materials.delete(row);
      const fails = failText(row);
      console.log(`판정 ${row.caseId} ${row.run}회차 ${fails.length ? `✗ ${fails.join(" / ")}` : "✓"}  (누적 $${spend.toFixed(2)})`);
    });
  };
  // 회차마다 같은 파일에 덮어써서, 중간에 멈춰도 끝난 회차는 남게 한다.
  const name = `${stamp()}${opts.tag ? `-${opts.tag}` : ""}`;
  let stoppedReason: string | undefined;
  const save = () => {
    const summaries = results.map(({ prompt, rows }) => summarize(prompt.name, rows, runs, model, !opts.noJudge));
    const md = [
      `# 퀴즈 생성 프롬프트 비교 ${name}`,
      "",
      `- 호출 경로 ${backend === "cli" ? "구독제 claude -p(cli-llm.ts, 시간은 duration_api_ms, 비용은 API 가격으로 환산한 값)" : "API(SDK)"}`,
      `- 모델 ${model}(effort low, max_tokens 4000, 30초), 판정 ${opts.noJudge ? "없음" : JUDGE_MODEL}`,
      `- develop 커밋: HEAD ${commit.head}, origin/develop ${commit.originDevelop}`,
      `- 입력 ${cases.length}건 × ${runs}회. 값은 "회차 평균 (최소 회차)"이다. 판정 항목은 생성 실패도 실패로 센다.`,
      stoppedReason ? `- **중간에 멈춤:** ${stoppedReason}` : "",
      `- 이번 실행에 쓴 API 비용: $${spend.toFixed(2)}`,
      "",
      table(summaries),
      "",
      ...results.map(({ prompt }) => `## ${prompt.name}\n\n${prompt.description ?? ""}\n\n${FENCE}\n${prompt.system.join("\n")}\n\n${Object.entries(prompt.formatRules).map(([k, v]) => `[${k}] ${v}`).join("\n")}\n${FENCE}`),
    ].join("\n");
    const path = writeResults(here, name, { backend, model, judgeModel: JUDGE_MODEL, commit, runs, spend, stoppedReason, cases: cases.map((c) => c.id), results }, md);
    return { path, summaries };
  };

  // --judge-only: 이미 생성한 결과 JSON에서 판정이 없는 행만 다시 판정한다(생성 시간과 토큰은 원래 값을 쓴다).
  const judgeOnly = opts["judge-only"] as string | undefined;
  if (judgeOnly) {
    const prev = JSON.parse(readFileSync(resolve(judgeOnly), "utf8")) as { runs: number; results: { prompt: Prompt; rows: Row[] }[] };
    runs = prev.runs;
    const caseById = new Map(caseFile.cases.map((c) => [c.id, c]));
    for (const { prompt, rows } of prev.results) {
      for (const row of rows) {
        // 자동 검사는 코드가 바뀌었을 수 있으므로 저장된 출력으로 다시 계산한다.
        if (row.output) row.auto = autoCheck(row.output, row.format);
        if (row.output && !row.judge && !opts.noJudge) {
          delete row.judgeError;
          materials.set(row, materialFor(caseById.get(row.caseId)!, row.output));
        }
      }
      results.push({ prompt, rows });
    }
    cases = caseFile.cases.filter((c) => prev.results[0].rows.some((r) => r.caseId === c.id));
  } else {
    outer: for (const prompt of prompts) {
      const rows: Row[] = [];
      results.push({ prompt, rows });
      for (let run = 1; run <= runs; run++) {
        console.log(`== 생성 ${prompt.name} ${run}회차`);
        const runRows = await mapLimit(cases, concurrency, async (c) => {
          const con = conceptById.get(c.conceptId);
          if (!con) throw new Error(`DB에 없는 절이다: ${c.conceptId}`);
          const u = unitById.get(con.unitId)!;
          const examples = prompt.fewshot ? pickExamples(c.format, c.conceptId, prompt.fewshot.count) : [];
          const baseSystem = `${prompt.system.join(" ")} ${prompt.formatRules[c.format]}`;
          const system = examples.length ? `${baseSystem}\n\n${examplesBlock(prompt.fewshot!.intro, examples)}` : baseSystem;
          const ctx = contextBlock(c, caseFile, u.id);
          const content = buildContent(u.content, con.id, con.title, c.format, ctx);
          const base = { run, caseId: c.id, conceptId: c.conceptId, sectionTitle: con.title, format: c.format, context: c.context, tags: c.tags ?? [] };
          let row: Row;
          try {
            const r = await retry(() =>
              gen({
                model,
                system,
                content,
                properties: { stem: { type: "string" }, hint: { type: "string" }, explanation: { type: "string" }, answer: ANSWER_SCHEMAS[c.format] },
                timeoutMs: TIMEOUT_MS,
              }),
            );
            row = { ...base, ms: r.ms, usage: r.usage, output: r.value, auto: autoCheck(r.value, c.format) };
            if (examples.length) {
              row.examples = examples.map((e) => e.id);
              row.auto!.copiedLines = copiedFrom(String(r.value.stem ?? ""), examples);
            }
            if ("cli" in r) row.cli = (r as { cli: Row["cli"] }).cli;
          } catch (error) {
            const e = error as CallError;
            row = { ...base, ms: e.ms ?? TIMEOUT_MS, usage: e.usage ?? emptyUsage(), error: e.message };
          }
          spend += costUsd(model, row.usage);
          if (row.output) materials.set(row, materialFor(c, row.output));
          const fails = failText(row);
          console.log(`${c.id} ${c.format}/${c.context} ${row.ms}ms ${fails.length ? `✗ ${fails.join(" / ")}` : "✓"}  (누적 $${spend.toFixed(2)})`);
          return row;
        });
        rows.push(...runRows);
        await judgePending();
        const { path } = save();
        console.log(`== ${prompt.name} ${run}회차 저장: ${path}`);
        if (backend === "cli" && quotaStopped()) {
          stoppedReason = `${prompt.name} ${run}회차에서 구독 사용량 한도 오류가 연달아 나서 남은 회차를 돌리지 않았다.`;
          break outer;
        }
      }
    }
  }

  // --judge-only일 때, 또는 마지막 회차 뒤에 남은 판정을 마저 하고 저장한다.
  await judgePending();
  if (backend === "cli" && quotaStopped() && !stoppedReason) stoppedReason = "구독 사용량 한도 오류가 연달아 나서 남은 호출을 건너뛰었다.";
  const { path, summaries } = save();
  console.log("\n" + table(summaries));
  console.log(`\n이번 실행 비용 $${spend.toFixed(2)}\n결과: ${path}`);
}

// 회차별 비율을 구해 "평균 (최소)"로 적는다.
// API 사용 한도 오류는 프롬프트와 상관없으므로 모든 통계에서 뺀다. 판정만 한도에 걸린 행은 생성 통계에는 넣고 판정 통계에서 뺀다.
const LIMIT_ERROR = /usage limits/;  // API 한도와 구독 한도 오류 메시지 모두 이 말을 담는다(cli-llm.ts 참고).
export function summarize(name: string, allRows: Row[], runs: number, model: string, judged: boolean) {
  const rows = allRows.filter((r) => !(r.error && LIMIT_ERROR.test(r.error)));
  const excluded = allRows.length - rows.length;
  const byRun = Array.from({ length: runs }, (_, i) => rows.filter((r) => r.run === i + 1)).filter((rs) => rs.length);
  const rate = (f: (r: Row) => boolean) => meanMin(byRun.map((rs) => (rs.filter(f).length / rs.length) * 100));
  const jp = (k: string) => (r: Row) => !!r.judge?.[k]?.pass;
  const autoOk = (r: Row) => !!r.auto && r.auto.parsed && r.auto.formatRule && r.auto.banned.length === 0 && r.auto.tableOk;
  const allOk = (r: Row) => autoOk(r) && JUDGE_KEYS.every((k) => jp(k)(r));
  const ok = rows.filter((r) => !r.error);
  const s: Record<string, string | number> = {
    버전: name,
    "모양 검사 통과 %": rate((r) => !!r.auto?.parsed),
    "형식 규칙 %": rate((r) => !!r.auto?.formatRule),
    "금지 표현 없음 %": rate((r) => !!r.auto && r.auto.banned.length === 0),
    "표 5행 이하 %": rate((r) => !!r.auto?.tableOk),
  };
  s["집계 행 수(회차)"] = `${rows.length}행(${byRun.map((rs) => rs.length).join("/")})${excluded ? `, 한도 오류 ${excluded}행 제외` : ""}`;
  // 판정이 한 건도 없는 버전(판정 호출이 모두 실패한 경우 등)은 판정 열을 0%로 적지 않고 아예 뺀다.
  if (judged && rows.some((r) => r.judge)) {
    // 판정 항목은 판정을 받은 행(또는 생성에 실패한 행)만으로 센다. 판정 호출이 한도에 걸린 행은 뺀다.
    const jrows = rows.filter((r) => !(r.judgeError && LIMIT_ERROR.test(r.judgeError)));
    const jByRun = Array.from({ length: runs }, (_, i) => jrows.filter((r) => r.run === i + 1)).filter((rs) => rs.length);
    const rate = (f: (r: Row) => boolean) => meanMin(jByRun.map((rs) => (rs.filter(f).length / rs.length) * 100));
    s["판정 집계 행 수"] = jrows.length;
    s["판정 오류 수"] = jrows.filter((r) => r.judgeError).length;
    s["출제 범위 %"] = rate(jp("scope"));
    s["정답 하나·맞음 %"] = rate(jp("answer_correct"));
    s["문제만으로 풀이 %"] = rate(jp("self_contained"));
    s["힌트 안전 %"] = rate(jp("hint_no_leak"));
    s["해설 맞음 %"] = rate(jp("explanation_correct"));
    s["SQLD 적합 %"] = rate(jp("sqld_fit"));
    s["전 항목 통과 %"] = rate(allOk);
  }
  s["30초 안 %"] = pct(ok.length, rows.length);
  s["평균 ms"] = avg(ok.map((r) => r.ms));
  s["최대 ms"] = max(ok.map((r) => r.ms));
  s["평균 입력 토큰"] = avg(rows.map((r) => r.usage.inputTokens));
  s["평균 출력 토큰"] = avg(rows.map((r) => r.usage.outputTokens));
  s["1,000건당 $"] = per1000(model, rows.map((r) => r.usage));
  s["생성 실패 수"] = rows.length - ok.length;
  if (rows.some((r) => r.examples)) s["예시 데이터 복사 행"] = rows.filter((r) => (r.auto?.copiedLines?.length ?? 0) > 0).length;
  if (rows.some((r) => r.cli)) s["CLI 재호출 수"] = rows.filter((r) => (r.cli?.extraCalls ?? 0) > 0).length;
  return s;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
