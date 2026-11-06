// 질문 개념 분류 프롬프트 평가 하네스. 저장소 루트에서 run.sh로 실행한다.
// 사용법: run.sh [프롬프트 파일 ...] [--questions 질문 파일]
// 프롬프트 파일을 여러 개 주면 같은 질문 세트로 차례로 돌려 비교표를 만든다. 주지 않으면 prompts/baseline.json을 쓴다.
//
// 프롬프트 파일 형식: { "name", "description"?, "system", "user", "schema"? }
//   conceptNotes에 "개념ID: 한 줄 정리" JSON 파일 경로(프롬프트 파일 기준)를 주면, 개념 줄 뒤에 " - 한 줄 정리"를 붙인다.
//   schema를 주면 응답 형식을 바꾼다. 개념을 conceptIds 배열 대신 conceptId 하나(문자열 또는 null)로 받아도 된다.
//   user 안의 {{CONCEPTS}}는 "개념ID: 개념 이름" 줄 목록으로, {{QUESTION}}은 질문으로 바뀐다.
//   {{CONCEPTS}}를 system에 넣어도 된다.
//
// 호출 설정은 lib/llm/ask-json.ts와 같다. 토큰 사용량을 받으려고 SDK를 직접 부르므로, 그 파일의 설정이 바뀌면 여기도 맞춘다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "@/lib/db";
import { concept } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { anthropic } from "@/lib/llm/client";

type Case = { question: string; expected: string[]; note?: string };
type Prompt = { name: string; description?: string; system: string; user: string; schema?: object; conceptNotes?: string };
type Verdict = "일치" | "부분 일치" | "불일치" | "오류";
type Row = Case & {
  verdict: Verdict;
  actual: string[];
  unknown: string[];
  keywords: string[];
  ms: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
};

// ADR 0007, 0008에 적힌 Haiku 5.5의 100만 토큰당 가격이다.
const PRICE = { input: 0.1, output: 0.5 };
const TIMEOUT_MS = 10_000;
const STRINGS = { type: "array", items: { type: "string" } };
const SCHEMA = {
  type: "object",
  properties: { conceptIds: STRINGS, keywords: STRINGS },
  required: ["conceptIds", "keywords"],
  additionalProperties: false,
};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const qIndex = args.indexOf("--questions");
const casesPath = qIndex >= 0 ? resolve(args[qIndex + 1]) : join(here, "questions.json");
const promptPaths = args.filter((_, i) => i !== qIndex && i !== qIndex + 1).map((p) => resolve(p));
if (promptPaths.length === 0) promptPaths.push(join(here, "prompts", "baseline.json"));

const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8"));
const prompts: (Prompt & { notes?: Record<string, string> })[] = promptPaths.map((p) => {
  const prompt: Prompt = { name: basename(p, ".json"), ...JSON.parse(readFileSync(p, "utf8")) };
  const notes = prompt.conceptNotes ? JSON.parse(readFileSync(resolve(dirname(p), prompt.conceptNotes), "utf8")) : undefined;
  return { ...prompt, notes };
});

function judge(expected: string[], actual: string[]): Verdict {
  const e = new Set(expected);
  const a = new Set(actual);
  if (e.size === a.size && [...e].every((id) => a.has(id))) return "일치";
  if ([...a].some((id) => e.has(id))) return "부분 일치";
  return "불일치";
}

const fill = (template: string, concepts: string, question: string) =>
  template.replaceAll("{{CONCEPTS}}", concepts).replaceAll("{{QUESTION}}", question);

async function classify(prompt: Prompt, conceptLines: string, question: string) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`${TIMEOUT_MS / 1000}초 안에 답하지 않았다.`)), TIMEOUT_MS);
  try {
    const response = await anthropic().messages.create(
      {
        model: env.ANTHROPIC_UTILITY_MODEL,
        max_tokens: 4000,
        output_config: { effort: "low", format: { type: "json_schema", schema: prompt.schema ?? SCHEMA } },
        system: fill(prompt.system, conceptLines, question),
        messages: [{ role: "user", content: fill(prompt.user, conceptLines, question) }],
      },
      { signal: abort.signal },
    );
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason !== "end_turn") throw Object.assign(new Error(`응답이 ${response.stop_reason}로 끝났다.`), usage);
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = JSON.parse(text) as { conceptIds?: string[]; conceptId?: string | null; keywords: string[] };
    const conceptIds = parsed.conceptIds ?? (parsed.conceptId ? [parsed.conceptId] : []);
    return { conceptIds, keywords: parsed.keywords, ...usage };
  } catch (error) {
    throw abort.signal.aborted ? abort.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

async function main() {
  const db = getDb();
  const concepts = (await db.select({ id: concept.id, title: concept.title }).from(concept)).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  await db.$client.end();
  const titles = new Map(concepts.map(({ id, title }) => [id, title]));
  const conceptLines = concepts.map(({ id, title }) => `${id}: ${title}`).join("\n");
  const linesFor = (prompt: (typeof prompts)[number]) =>
    prompt.notes ? concepts.map(({ id, title }) => `${id}: ${title}${prompt.notes![id] ? ` - ${prompt.notes![id]}` : ""}`).join("\n") : conceptLines;
  const label = (ids: string[]) => ids.map((id) => `${id} ${titles.get(id) ?? "?"}`).join("<br>") || "(없음)";
  console.log(`개념 ${concepts.length}개, 질문 ${cases.length}개, 프롬프트 ${prompts.length}개\n`);

  const results: { prompt: Prompt; rows: Row[]; summary: Record<string, string | number> }[] = [];
  for (const prompt of prompts) {
    console.log(`== ${prompt.name}`);
    const rows: Row[] = [];
    for (const [i, c] of cases.entries()) {
      const started = performance.now();
      try {
        const r = await classify(prompt, linesFor(prompt), c.question);
        const ms = Math.round(performance.now() - started);
        // 서버 코드와 같이 목록에 있는 ID만 남기고 중복을 버린다.
        const actual = [...new Set(r.conceptIds.filter((id) => titles.has(id)))];
        const unknown = r.conceptIds.filter((id) => !titles.has(id));
        const verdict = judge(c.expected, actual);
        rows.push({ ...c, verdict, actual, unknown, keywords: r.keywords, ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
        console.log(`${i + 1}. [${verdict}] ${c.question} → ${actual.join(", ") || "(없음)"} (${ms}ms, in ${r.inputTokens}, out ${r.outputTokens})`);
      } catch (error) {
        const ms = Math.round(performance.now() - started);
        const e = error as Error & { inputTokens?: number; outputTokens?: number };
        rows.push({ ...c, verdict: "오류", actual: [], unknown: [], keywords: [], ms, inputTokens: e.inputTokens ?? 0, outputTokens: e.outputTokens ?? 0, error: e.message });
        console.log(`${i + 1}. [오류] ${c.question} → ${e.message}`);
      }
    }
    const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
    const inSum = rows.reduce((a, r) => a + r.inputTokens, 0);
    const outSum = rows.reduce((a, r) => a + r.outputTokens, 0);
    const cost = (inSum * PRICE.input + outSum * PRICE.output) / 1_000_000;
    const summary = {
      프롬프트: prompt.name,
      일치: count("일치"),
      "부분 일치": count("부분 일치"),
      불일치: count("불일치"),
      오류: count("오류"),
      "평균 시간 ms": avg(rows.map((r) => r.ms)),
      "최대 시간 ms": Math.max(...rows.map((r) => r.ms)),
      "평균 입력 토큰": avg(rows.map((r) => r.inputTokens)),
      "평균 출력 토큰": avg(rows.map((r) => r.outputTokens)),
      "질문 1,000건 비용 $": Number(((cost / rows.length) * 1000).toFixed(3)),
    };
    console.log(`→ ${JSON.stringify(summary)}\n`);
    results.push({ prompt, rows, summary });
  }

  const keys = Object.keys(results[0].summary);
  const compare = [
    `| ${keys.join(" | ")} |`,
    `|${keys.map(() => "---").join("|")}|`,
    ...results.map(({ summary }) => `| ${keys.map((k) => summary[k]).join(" | ")} |`),
  ].join("\n");

  const detail = results
    .map(({ prompt, rows }) =>
      [
        `## ${prompt.name}`,
        prompt.description ? `\n${prompt.description}\n` : "",
        "**System**\n\n```\n" + prompt.system + "\n```\n",
        "**User**\n\n```\n" + prompt.user + "\n```\n",
        "| # | 결과 | 질문 | 기대 | 실제 | 키워드 | 시간 | 입력 | 출력 | 메모 |",
        "|---|---|---|---|---|---|---|---|---|---|",
        ...rows.map(
          (r, i) =>
            `| ${i + 1} | ${r.verdict} | ${cell(r.question)} | ${label(r.expected)} | ${label(r.actual)}${r.unknown.length ? `<br>목록에 없는 ID: ${r.unknown.join(", ")}` : ""} | ${cell(r.keywords.join(", "))} | ${r.ms}ms | ${r.inputTokens} | ${r.outputTokens} | ${cell([r.note, r.error].filter(Boolean).join(" / "))} |`,
        ),
      ].join("\n"),
    )
    .join("\n\n");

  const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  const md = `# 분류 프롬프트 비교 ${stamp}\n\n모델 ${env.ANTHROPIC_UTILITY_MODEL}, effort low, 개념 ${concepts.length}개, 질문 ${cases.length}개\n\n${compare}\n\n${detail}\n`;
  writeFileSync(join(outDir, `${stamp}.md`), md);
  writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(compare);
  console.log(`\n결과: ${join(outDir, `${stamp}.md`)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
