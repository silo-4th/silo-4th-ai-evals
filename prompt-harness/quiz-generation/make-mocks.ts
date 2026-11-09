// 퓨샷 시험용 목업(빈칸, 서술형)을 만든다. 서비스의 기본 문제(lib/default-quiz-problems.ts)는 모두 객관식이라,
// 객관식 문제의 데이터와 SQL을 그대로 두고 형식만 빈칸과 서술형으로 바꾼다. 구독제 claude -p(Opus 5.5, effort high)로 부른다.
// 만든 목업은 fewshot-mocks.json에 쓰고, 판정자(Opus)로 정답과 해설을 검증해 결과를 함께 적는다.
// 사용법: sh ../shared/run.sh quiz-generation/make-mocks.ts  (prompt-harness 폴더에서)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_QUIZ_PROBLEMS } from "@/lib/default-quiz-problems";
import { getDb } from "@/lib/db";
import { concept } from "@/lib/db/schema";
import { mapLimit } from "../shared/llm";
import { callJsonCli, judgeCli, withRetryCli } from "./cli-llm";
import { CRITERIA, renderProblem } from "./harness";

const here = dirname(fileURLToPath(import.meta.url));
// 단원마다 서로 다른 절 두 개씩 고른다.
const SOURCES = ["s2-05-2", "s2-05-4", "s2-07-3", "s2-07-6", "s2-09-3", "s2-09-4", "s2-11-2", "s2-11-4", "s2-12-3", "s2-12-4"];

const textList = { type: "array", items: { type: "string" } };
const SCHEMAS = {
  blank: { accepted: textList },
  free: { modelAnswer: { type: "string" }, keyPoints: textList },
} as const;

const RULES = {
  blank:
    "빈칸 문제로 바꾼다. stem에 밑줄 네 개 ____로 빈칸을 정확히 하나 둔다. 빈칸에는 원래 객관식의 정답에 해당하는 결과 값, 행 수, 키워드처럼 풀이가 필요한 답을 둔다. accepted에는 빈칸 자리에 그대로 넣었을 때 맞는 답을 모두 넣는다(같은 값의 다른 표기 포함).",
  free:
    "서술형 문제로 바꾼다. 원래 객관식의 정답을 구하고 그 이유를 설명하게 묻는다. modelAnswer에 모범 답을, keyPoints에 채점할 핵심 요소 3~5개를 넣는다. keyPoints에는 stem이 묻는 것만 넣는다.",
};

const SYSTEM =
  "SQLD 학습 서비스에 등록된 객관식 문제를 같은 데이터와 SQL로 다른 형식의 문제로 바꾼다. 문제 안의 표와 SQL, 다루는 개념은 바꾸지 않고, 질문 문장과 답 형식만 바꾼다. 결과는 표와 SQL로 직접 계산해서 확인한다. hint는 정답을 드러내지 않고 떠올릴 실마리만 주고, 정답 용어의 정의, 계산 결과, 풀이 공식을 그대로 쓰지 않는다. explanation은 정답의 이유를 설명한다. 말투는 원래 문제와 같게 한다.";

async function main() {
  const db = getDb();
  const concepts = await db.select().from(concept);
  await db.$client.end();
  const title = new Map(concepts.map((c) => [c.id, c.title]));
  const sources = SOURCES.map((id) => {
    const p = DEFAULT_QUIZ_PROBLEMS.find((q) => q.conceptId === id);
    if (!p) throw new Error(`기본 문제가 없는 절이다: ${id}`);
    return p;
  });
  const jobs = sources.flatMap((p) => (["blank", "free"] as const).map((format) => ({ p, format })));
  const mocks = await mapLimit(jobs, 3, async ({ p, format }) => {
    const r = await withRetryCli(() =>
      callJsonCli({
        model: "claude-opus-5-5",
        effort: "high",
        system: `${SYSTEM} ${RULES[format]}`,
        content: `<source_problem concept="${title.get(p.conceptId)}">\n${renderProblem(p as unknown as Record<string, unknown>, "mcq")}\n</source_problem>`,
        properties: { stem: { type: "string" }, hint: { type: "string" }, explanation: { type: "string" }, answer: { type: "object", properties: SCHEMAS[format], required: Object.keys(SCHEMAS[format]), additionalProperties: false } },
        timeoutMs: 300_000,
        maxTokens: 8000,
      }),
    );
    const out = r.value as Record<string, unknown>;
    const mock = { id: `mock-${p.conceptId}-${format}`, conceptId: p.conceptId, format, source: `default:${p.conceptId}:mcq`, mock: true, ...out };
    const j = await judgeCli({
      task: "SQLD 학습 서비스의 퀴즈 문제 하나를 판정한다. 학습자는 학습 화면 없이 문제만 본다. 출제 범위 기준은 문제가 이 절의 내용을 묻는지로 본다.",
      criteria: CRITERIA,
      material: `<target_section>\n${title.get(p.conceptId)}\n</target_section>\n\n<generated_problem>\n${renderProblem(out, format)}\n</generated_problem>`,
    });
    const fails = Object.entries(j.items).filter(([, v]) => !v.pass).map(([k, v]) => `${k}: ${v.reason}`);
    console.log(`${mock.id} ${fails.length ? `✗ ${fails.join(" / ")}` : "✓"}`);
    return { ...mock, check: { pass: fails.length === 0, fails } };
  });
  const path = join(here, "fewshot-mocks.json");
  writeFileSync(path, JSON.stringify({ note: "기본 객관식 문제를 같은 데이터로 바꾼 목업이다. AI가 만들었고 PO 검수 전이다(labels-draft와 같은 지위).", mocks }, null, 2));
  console.log(`저장: ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
