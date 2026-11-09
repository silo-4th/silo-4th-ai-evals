// 질문 요약 프롬프트(lib/llm/tagging.ts summarizeQuestion) 평가 하네스.
// 사용법(summary/ 폴더에서): sh run.sh [프롬프트 파일 ...] [--runs 3] [--limit N] [--no-judge] [--followup N] [--inputs 파일]
//   프롬프트 파일을 주지 않으면 prompts/baseline.json을 쓴다. 여러 개 주면 같은 입력으로 차례로 돌려 비교표를 만든다.
//   --runs: 버전마다 몇 번 돌릴지(기본 3). --limit: 입력 앞 N개만 쓴다(시험용).
//   --no-judge: Opus 판정을 건너뛴다. --followup N: 후속 질문 시험을 followups.json 앞 N개로 첫 실행 결과에 대해 한다.
//
// 프롬프트 파일 형식: { "name", "description"?, "system", "user" }. user 안의 {{QUESTION}}, {{ANSWER}}가 질문과 답으로 바뀐다.
// 호출 설정은 askJson과 같다(shared/llm.ts callJson): Haiku 5.5, effort low, max_tokens 4000, JSON 스키마, 30초.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "@/lib/db";
import { unit } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { callJson, mapLimit, streamText, withRetry, type CallError } from "../shared/llm";
import { judge, JUDGE_MODEL, type JudgeItem } from "../shared/judge";
import { callJsonCli, callTextCli, judgeCli, quotaStopped, QUOTA_ERROR, withRetryCli } from "./cli-llm";
import { costUsd, emptyUsage, per1000, type Usage } from "../shared/cost";
import { avg, commitInfo, max, meanMin, stamp, table, writeResults } from "../shared/record";

type Pair = { id: string; source: string; unitId: string; question: string; answer: string; note?: string };
type Prompt = { name: string; description?: string; system: string; user: string };
type Followup = { id: string; followup: string };

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 30_000;
const STRINGS = { type: "array", items: { type: "string" } };
// --backend cli: 구독제 claude -p 경로(cli-llm.ts). 기본은 API 키 경로다.
const backend = (process.argv.includes("--backend") ? process.argv[process.argv.indexOf("--backend") + 1] : "api") as "api" | "cli";
// 구독 하나를 여러 트랙이 나눠 쓰므로 CLI 경로는 동시 3개로 줄인다.
const CONCURRENCY = backend === "cli" ? 3 : 4;
// 사용 한도 초과처럼 다시 불러도 소용없는 오류가 나면 남은 호출을 멈추고, 그때까지의 결과를 저장한다.
let halted: string | undefined;
const fatal = (e: unknown) => /usage limits|credit balance/i.test(String((e as Error)?.message ?? e)) && (backend === "api" || quotaStopped());
// 한도 때문에 실패한 행이다. 프롬프트 실패가 아니므로 통계에서 뺀다.
const isQuotaRow = (r: { error?: string; judgeError?: string }) => isQuota(r.error) || isQuota(r.judgeError);
const isQuota = (msg?: string) => !!msg && (msg.startsWith("중단:") || QUOTA_ERROR.test(msg) || /usage limits/i.test(msg));

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Number(opt("--runs") ?? 3);
const limit = opt("--limit") ? Number(opt("--limit")) : undefined;
const followupN = opt("--followup") ? Number(opt("--followup")) : 0;
const noJudge = args.includes("--no-judge");
const valued = new Set(["--runs", "--limit", "--followup", "--inputs", "--backend", "--resume", "--criteria"]);
// --resume a-partial.json,b-partial.json: 끊긴 실행의 회차별 결과를 읽어, 끝난 회차는 건너뛰고 다음 회차부터 잇는다.
const resumed = new Map<string, Row[]>(
  (opt("--resume") ?? "")
    .split(",")
    .filter(Boolean)
    .map((f) => JSON.parse(readFileSync(resolve(f), "utf8")) as { prompt: Prompt; rows: Row[] })
    .map((d) => [d.prompt.name, d.rows.filter((r) => !isQuotaRow(r))]),
);
const promptPaths = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1])).map((p) => resolve(p));
if (promptPaths.length === 0) promptPaths.push(join(here, "prompts", "baseline.json"));

// --inputs로 입력 파일을 바꿀 수 있다(예: inputs-short.json). 기본은 inputs.json이다.
const inputsPath = opt("--inputs") ? resolve(opt("--inputs")!) : join(here, "inputs.json");
const pairs: Pair[] = JSON.parse(readFileSync(inputsPath, "utf8")).slice(0, limit);
const prompts: Prompt[] = promptPaths.map((p) => ({ name: basename(p, ".json"), ...JSON.parse(readFileSync(p, "utf8")) }));

// keywords 자동 검사 기준(11/8 PO 결정): 학습 입력은 1~5개, 학습과 무관한 입력(junk)은 0개, 애매한 입력(either)은 0~5개다.
// 입력 분류는 labels-draft-kw.json(AI 초안, PO 검수 전)에서 읽는다. 목록에 없는 ID는 학습 입력으로 본다.
const kwLabels: Record<string, string> = existsSync(join(here, "labels-draft-kw.json"))
  ? JSON.parse(readFileSync(join(here, "labels-draft-kw.json"), "utf8"))
  : {};
const kwOk = (id: string, n: number) =>
  kwLabels[id] === "junk" ? n === 0 : kwLabels[id] === "either" ? n <= 5 : n >= 1 && n <= 5;

const fill = (t: string, p: Pair) => t.replaceAll("{{QUESTION}}", p.question).replaceAll("{{ANSWER}}", p.answer);

// 문장 수: 마침표, 물음표, 느낌표 뒤에 공백이나 끝이 오면 한 문장으로 센다. 끝에 부호가 없으면 마지막 조각도 한 문장이다.
export function sentenceCount(text: string) {
  const t = text.trim();
  if (!t) return 0;
  const ends = t.match(/[.!?](?=\s|$)/g)?.length ?? 0;
  return /[.!?]$/.test(t) ? ends : ends + 1;
}

const ALL_CRITERIA = [
  { key: "intent", question: "질문 의도: 학습자가 무엇을 물었는지(무엇을 알고 싶었는지)가 요약에 구체적으로 드러나는가. 학습과 무관한 입력이면 그런 입력이었다는 점이 드러나면 통과다." },
  {
    key: "confusion",
    question:
      "헷갈린 지점: 퀴즈 출제자가 이 요약만 보고 학습자가 어디를 헷갈리거나 몰랐는지(어떤 개념, 어떤 경우, 어떤 오해)를 알아볼 수 있는가. 단순히 주제 이름만 있으면 실패다. 학습과 무관한 입력이면, 헷갈린 학습 내용이 없다는 점이 드러나거나 학습 내용으로 잘못 꾸며내지 않았으면 통과다.",
  },
  { key: "conclusion", question: "답의 핵심 결론: AI 답의 핵심 결론(규칙, 결과값, 차이점 등)이 요약에 들어 있어, 다음 답변에서 앞서 무엇을 답했는지 이어 갈 수 있는가." },
  { key: "faithful", question: "충실성: 요약에 질문과 답에 없는 내용, 답과 다른 내용, 틀린 SQL 지식이 없는가." },
];
// --criteria conclusion,faithful,confusion: 버전 사이에 차이가 나는 판정 항목만 판정해 시간과 비용을 줄인다. 기본은 네 항목 전부다.
const CRITERIA = opt("--criteria") ? ALL_CRITERIA.filter((c) => opt("--criteria")!.split(",").includes(c.key)) : ALL_CRITERIA;
const TASK = [
  "학습 서비스는 학습자의 질문과 AI 답을 짧게 요약해 저장한다. 요약은 두 곳에 쓰인다.",
  "1) 같은 학습자가 나중에 비슷한 내용을 다시 물을 때, 답변 프롬프트의 <past_questions>에 원문 대신 들어간다. 그래서 무엇을 물었고 어떤 결론을 받았는지가 남아야 한다.",
  "2) 퀴즈 문제를 만들 때 <conversation_summaries>로 들어가, 학습자가 헷갈린 지점을 짚는 문제를 내는 데 쓰인다.",
  "아래 <question>, <answer>는 원문이고 <summary>, <keywords>는 판정할 요약이다. 이 두 쓰임새에 비추어 기준마다 판정한다.",
].join("\n");

type Row = {
  run: number;
  id: string;
  source: string;
  summary: string;
  keywords: string[];
  chars: number;
  sentences: number;
  autoLen: boolean;
  autoSent: boolean;
  autoKw: boolean;
  ms: number;
  usage: Usage;
  error?: string;
  judged?: Record<string, JudgeItem>;
  judgeUsage?: Usage;
  judgeError?: string;
  cliExtraCalls?: number;
  judgeCliExtraCalls?: number;
};

async function summarize(prompt: Prompt, pair: Pair, run: number): Promise<Row> {
  const base = { run, id: pair.id, source: pair.source };
  if (halted) return { ...base, summary: "", keywords: [], chars: 0, sentences: 0, autoLen: false, autoSent: false, autoKw: false, ms: 0, usage: emptyUsage(), error: `중단: ${halted}` };
  try {
    const req = {
      model: env.ANTHROPIC_UTILITY_MODEL,
      system: fill(prompt.system, pair),
      content: fill(prompt.user, pair),
      properties: { summary: { type: "string" }, keywords: STRINGS },
      timeoutMs: TIMEOUT_MS,
    };
    const r: Awaited<ReturnType<typeof callJson<{ summary: string; keywords: string[] }>>> & { cli?: { extraCalls: number } } =
      backend === "cli"
        ? await withRetryCli(() => callJsonCli<{ summary: string; keywords: string[] }>(req))
        : await withRetry(() => callJson<{ summary: string; keywords: string[] }>(req));
    const summary = String(r.value.summary ?? "").trim();
    if (!summary) throw Object.assign(new Error("AI 요약이 비어 있다."), { usage: r.usage, ms: r.ms });
    const keywords = Array.isArray(r.value.keywords) ? r.value.keywords : [];
    const chars = [...summary].length;
    const sentences = sentenceCount(summary);
    return {
      ...base,
      summary,
      keywords,
      chars,
      sentences,
      autoLen: chars <= 300,
      autoSent: sentences >= 2 && sentences <= 3,
      autoKw: kwOk(pair.id, keywords.length),
      ms: r.ms,
      usage: r.usage,
      cliExtraCalls: r.cli?.extraCalls,
    };
  } catch (e) {
    const err = e as CallError;
    if (fatal(e)) halted ??= err.message;
    return { ...base, summary: "", keywords: [], chars: 0, sentences: 0, autoLen: false, autoSent: false, autoKw: false, ms: err.ms ?? 0, usage: err.usage ?? emptyUsage(), error: err.message };
  }
}

async function judgeRow(row: Row, pair: Pair) {
  if (row.error || halted) return;
  const material = `<question>\n${pair.question}\n</question>\n\n<answer>\n${pair.answer}\n</answer>\n\n<summary>\n${row.summary}\n</summary>\n\n<keywords>${row.keywords.join(", ")}</keywords>`;
  try {
    const j = await (backend === "cli" ? judgeCli : judge)({ task: TASK, criteria: CRITERIA, material });
    row.judged = j.items;
    row.judgeUsage = j.usage;
  } catch (e) {
    if (fatal(e)) halted ??= (e as Error).message;
    row.judgeError = (e as Error).message;
  }
}

// 후속 질문 시험: 같은 후속 질문을 (가) 원문 대화를 앞 대화로 넣어 답하게 하고, (나) 요약만 <past_questions>로 넣어 답하게 한 뒤 비교한다.
// (가)는 버전과 무관하므로 한 번만 만든다. 서비스의 streamAnswer와 같은 설정이다.
const ANSWER_SYSTEM = "학습자가 아래 단원을 읽다가 질문했다. 단원 내용을 바탕으로 한국어로 답한다.";
const pastQuestionsBlock = (summaries: string[]) =>
  `학습자가 전에 비슷한 내용으로 물었던 질문의 요약이다. 이어지는 질문이면 참고해 답한다.\n<past_questions>\n${summaries.map((s) => `- ${s}`).join("\n")}\n</past_questions>`;

async function answerWith(unitContent: string, extra: { history?: [string, string]; past?: string }, followup: string) {
  if (backend === "cli") {
    // CLI는 앞 대화를 messages로 넣을 수 없어서, 원문 대화 조건은 <previous_conversation>으로 system 끝에 붙인다(서비스와 다른 점).
    const system = [
      ANSWER_SYSTEM,
      `<unit>\n${unitContent}\n</unit>`,
      ...(extra.past ? [pastQuestionsBlock([extra.past])] : []),
      ...(extra.history
        ? [`같은 대화에서 학습자가 앞서 물은 질문과 받은 답이다.\n<previous_conversation>\n<question>\n${extra.history[0]}\n</question>\n<answer>\n${extra.history[1]}\n</answer>\n</previous_conversation>`]
        : []),
    ].join("\n\n");
    return withRetryCli(() => callTextCli({ model: env.ANTHROPIC_MODEL, system, content: followup }));
  }
  return withRetry(() =>
    streamText({
      model: env.ANTHROPIC_MODEL,
      system: [
        { type: "text", text: ANSWER_SYSTEM },
        { type: "text", text: `<unit>\n${unitContent}\n</unit>`, cache_control: { type: "ephemeral" } },
        ...(extra.past ? [{ type: "text" as const, text: pastQuestionsBlock([extra.past]) }] : []),
      ],
      messages: [
        ...(extra.history
          ? [
              { role: "user" as const, content: extra.history[0] },
              { role: "assistant" as const, content: extra.history[1] },
            ]
          : []),
        { role: "user", content: followup },
      ],
    }),
  );
}

const FOLLOW_CRITERIA = [
  {
    key: "continuity",
    question:
      "이어짐: <answer_with_summary>가 앞 대화를 알고 답한 것처럼 후속 질문에 맞게 답했는가. <answer_with_original>과 비교해, 앞 대화의 결론을 잘못 기억하거나 무엇을 가리키는지 몰라 엉뚱하게 답했다면 실패다. 표현과 길이 차이는 보지 않는다.",
  },
];

async function main() {
  const commit = commitInfo();
  const startedAt = stamp();
  const pairById = new Map(pairs.map((p) => [p.id, p]));
  const results: { prompt: Prompt; rows: Row[]; follow?: unknown[] }[] = [];
  let judgeSpend = 0;
  let sonnetSpend = 0;

  for (const prompt of prompts) {
    const rows: Row[] = [...(resumed.get(prompt.name) ?? [])];
    const doneRuns = new Set(rows.map((r) => r.run));
    // 끝까지 돈 회차만 남긴다. 중간에 끊긴 회차는 다시 돈다.
    for (const k of [...doneRuns]) if (rows.filter((r) => r.run === k).length < pairs.length) {
      doneRuns.delete(k);
      rows.splice(0, rows.length, ...rows.filter((r) => r.run !== k));
    }
    for (let run = 1; run <= runs; run++) {
      if (doneRuns.has(run)) continue;
      const got = await mapLimit(pairs, CONCURRENCY, async (pair) => {
        const row = await summarize(prompt, pair, run);
        if (!noJudge) await judgeRow(row, pair);
        process.stdout.write(row.error ? "x" : row.judgeError ? "j" : ".");
        return row;
      });
      rows.push(...got);
      console.log(` ${prompt.name} ${run}회차 끝`);
      mkdirSync(join(here, "results"), { recursive: true });
      writeFileSync(join(here, "results", `${startedAt}-${prompt.name}-partial.json`), JSON.stringify({ prompt, rows, halted }, null, 1));
      if (halted) break;
    }
    judgeSpend += rows.reduce((a, r) => a + (r.judgeUsage ? costUsd(JUDGE_MODEL, r.judgeUsage) : 0), 0);
    results.push({ prompt, rows });
  }

  // 후속 질문 시험(선택). 첫 실행의 요약을 쓴다.
  if (followupN > 0 && !halted) {
    const followups: Followup[] = JSON.parse(readFileSync(join(here, "followups.json"), "utf8")).slice(0, followupN);
    const db = getDb();
    const units = new Map((await db.select().from(unit)).map((u) => [u.id, u.content]));
    await db.$client.end();
    const refs = await mapLimit(followups, CONCURRENCY, async (f) => {
      const p = pairById.get(f.id)!;
      try {
        const r = await answerWith(units.get(p.unitId)!, { history: [p.question, p.answer] }, f.followup);
        sonnetSpend += costUsd(env.ANTHROPIC_MODEL, r.usage);
        return r.value;
      } catch (e) {
        if (fatal(e)) halted ??= (e as Error).message;
        return undefined;
      }
    });
    for (const res of results) {
      res.follow = await mapLimit(followups, CONCURRENCY, async (f, i) => {
        const p = pairById.get(f.id)!;
        if (halted || refs[i] === undefined) return { id: f.id, error: halted ?? "원문 답 없음" };
        try {
        const row = res.rows.find((r) => r.run === 1 && r.id === f.id);
        if (!row || row.error) return { id: f.id, error: "요약 없음" };
        const a = await answerWith(units.get(p.unitId)!, { past: row.summary }, f.followup);
        sonnetSpend += costUsd(env.ANTHROPIC_MODEL, a.usage);
        const j = await (backend === "cli" ? judgeCli : judge)({
          task: "학습 서비스는 같은 학습자의 과거 질문을 원문 대신 요약으로 답변 프롬프트에 넣는다. 요약만 넣었을 때도 후속 질문에 원문을 넣었을 때처럼 이어서 답할 수 있는지 본다.",
          criteria: FOLLOW_CRITERIA,
          material: `<earlier_question>\n${p.question}\n</earlier_question>\n<earlier_answer>\n${p.answer}\n</earlier_answer>\n<summary>\n${row.summary}\n</summary>\n<followup>\n${f.followup}\n</followup>\n<answer_with_original>\n${refs[i]}\n</answer_with_original>\n<answer_with_summary>\n${a.value}\n</answer_with_summary>`,
        });
        judgeSpend += costUsd(JUDGE_MODEL, j.usage);
        process.stdout.write("f");
        return { id: f.id, followup: f.followup, summary: row.summary, withOriginal: refs[i], withSummary: a.value, judged: j.items };
        } catch (e) {
          if (fatal(e)) halted ??= (e as Error).message;
          return { id: f.id, error: (e as Error).message };
        }
      });
    }
    console.log();
  }

  // 비교표. 품질 지표는 실행마다 비율을 낸 뒤 평균(최소)으로 적는다.
  const counted = (r: Row) => !isQuota(r.error) && !isQuota(r.judgeError);
  const perRun = (rows: Row[], f: (r: Row) => boolean, base: (r: Row) => boolean = () => true) =>
    Array.from({ length: runs }, (_, k) => {
      const rs = rows.filter((r) => r.run === k + 1 && counted(r) && base(r));
      return rs.length ? (rs.filter(f).length / rs.length) * 100 : NaN;
    }).filter((x) => !Number.isNaN(x));
  const judged = (r: Row) => !!r.judged;
  const summaryRows = results.map(({ prompt, rows, follow }) => {
    const ok = rows.filter((r) => !r.error);
    const row: Record<string, unknown> = {
      버전: prompt.name,
      "집계 행": rows.filter(counted).length,
      "300자 이내 %": meanMin(perRun(rows, (r) => r.autoLen)),
      "2~3문장 %": meanMin(perRun(rows, (r) => r.autoSent)),
      "keywords 기준 %": meanMin(perRun(rows, (r) => r.autoKw)),
      "글자 수 평균/최대": `${avg(ok.map((r) => r.chars))} / ${max(ok.map((r) => r.chars))}`,
    };
    if (!noJudge) {
      for (const c of CRITERIA) row[`${c.key} %`] = meanMin(perRun(rows, (r) => !!r.judged?.[c.key]?.pass, judged));
      row[`판정 ${CRITERIA.length}항목 모두 %`] = meanMin(perRun(rows, (r) => CRITERIA.every((c) => r.judged?.[c.key]?.pass), judged));
    }
    if (follow) {
      const f = follow as { judged?: Record<string, JudgeItem> }[];
      row["후속 질문 통과"] = `${f.filter((x) => x.judged?.continuity?.pass).length}/${f.filter((x) => x.judged).length}`;
    }
    row["평균/최대 ms"] = `${avg(ok.map((r) => r.ms))} / ${max(ok.map((r) => r.ms))}`;
    row["출력 토큰 평균"] = avg(ok.map((r) => r.usage.outputTokens));
    row["1,000건당 $"] = per1000(env.ANTHROPIC_UTILITY_MODEL, ok.map((r) => r.usage));
    row["호출 실패"] = rows.filter((r) => r.error && counted(r)).length;
    row["한도로 빠진 행"] = rows.filter((r) => !counted(r)).length;
    if (backend === "cli") {
      row["CLI 재호출(요약)"] = ok.reduce((a, r) => a + (r.cliExtraCalls ?? 0), 0);
    }
    row["판정 실패"] = rows.filter((r) => r.judgeError).length;
    return row;
  });
  const summarySpend = results.reduce((a, { rows }) => a + rows.reduce((b, r) => b + costUsd(env.ANTHROPIC_UTILITY_MODEL, r.usage), 0), 0);

  const name = stamp();
  const md = [
    `# 요약 프롬프트 실행 결과 ${name}`,
    "",
    `- develop 커밋: HEAD ${commit.head}, origin/develop ${commit.originDevelop}`,
    backend === "cli" ? "- **구독제 CLI 조건**(claude -p). 시간과 비용은 참고값이다. 비용은 같은 토큰을 API 가격으로 환산한 값이다." : "- API 키 조건",
    `- 요약 모델: ${env.ANTHROPIC_UTILITY_MODEL}, 판정 모델: ${noJudge ? "(판정 생략)" : JUDGE_MODEL}`,
    `- 입력: ${basename(inputsPath)} ${pairs.length}쌍, 버전마다 ${runs}회. 비율은 "평균 (최소)"이다.`,
    followupN ? `- 후속 질문 시험: followups.json 앞 ${followupN}건, 1회차 요약으로 1번만 돌렸다.` : "",
    halted ? `- **중단됨:** ${halted}` : "",
    `- 이번 실행 비용: 요약 $${summarySpend.toFixed(3)}, 판정 $${judgeSpend.toFixed(3)}, 후속 답변 $${sonnetSpend.toFixed(3)}`,
    "",
    table(summaryRows),
    "",
    ...results.flatMap(({ prompt, rows }) => {
      const bad = rows.filter((r) => counted(r) && (r.error || !r.autoLen || !r.autoSent || !r.autoKw || (r.judged && CRITERIA.some((c) => !r.judged![c.key].pass))));
      return [
        `## ${prompt.name} 실패 사례 (${bad.length}건)`,
        "",
        table(
          bad.map((r) => ({
            회차: r.run,
            id: r.id,
            질문: pairById.get(r.id)!.question.slice(0, 60),
            요약: r.error ?? r.summary,
            자동: `${r.chars}자 ${r.sentences}문장 kw${r.keywords.length}`,
            판정: r.judged ? CRITERIA.filter((c) => !r.judged![c.key].pass).map((c) => `${c.key}: ${r.judged![c.key].reason}`).join(" / ") : (r.judgeError ?? ""),
          })),
        ),
        "",
      ];
    }),
  ].join("\n");
  const path = writeResults(here, name, { commit, backend, runs, inputs: pairs.length, spend: { summarySpend, judgeSpend, sonnetSpend }, summaryRows, results }, md);
  console.log(table(summaryRows));
  console.log(`비용: 요약 $${summarySpend.toFixed(3)}, 판정 $${judgeSpend.toFixed(3)}, 후속 답변 $${sonnetSpend.toFixed(3)}`);
  console.log(path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
