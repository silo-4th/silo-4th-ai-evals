// 기본 문제를 세 형식으로 등록하기 위한 빈칸, 서술형 초안을 만든다(Linear 4-124, 절 24개 모두).
// 서비스 기본 객관식(lib/default-quiz-problems.ts)에서 절마다 첫 문제를 골라, 같은 표와 SQL로 빈칸과 서술형을 만든다.
// 문제 생성 원칙은 실험에서 정한 v4-blank 프롬프트(prompts/v4-blank.json)의 system 문장과 형식 규칙을 그대로 쓴다.
// 각 초안은 자동 검사(형식 규칙, 금지 표현, 표 5행 이하)와 판정자(Opus, CRITERIA 6개)를 모두 통과해야 한다.
// 실패하면 실패 이유를 붙여 최대 3번까지 다시 만든다. 결과는 default-drafts.json에 쓴다. PO 검수 전 초안이다.
// 사용법: sh ../shared/run.sh quiz-generation/make-defaults.ts  (prompt-harness 폴더에서)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_QUIZ_PROBLEMS } from "@/lib/default-quiz-problems";
import { getDb } from "@/lib/db";
import { concept } from "@/lib/db/schema";
import { mapLimit } from "../shared/llm";
import { callJsonCli, judgeCli, withRetryCli } from "./cli-llm";
import { autoCheck, CRITERIA, renderProblem } from "./harness";

const here = dirname(fileURLToPath(import.meta.url));
const MAX_TRIES = 3;
const principles = JSON.parse(readFileSync(join(here, "prompts/v4-blank.json"), "utf8")) as {
  system: string[];
  formatRules: Record<"blank" | "free", string>;
};

const textList = { type: "array", items: { type: "string" } };
const SCHEMAS = {
  blank: { accepted: textList },
  free: { modelAnswer: { type: "string" }, keyPoints: textList },
} as const;

// v4-blank 원칙 위에, 등록된 객관식을 같은 데이터로 바꾸는 작업 지시만 더한다.
const CONVERT =
  "이번에는 새 절 내용 대신 source_problem으로 받은 등록 객관식 문제를 같은 형식 규칙의 다른 형식 문제로 바꾼다. 문제 안의 표와 SQL, 다루는 개념은 그대로 쓰고 질문 문장과 답 형식만 바꾼다. 결과는 표와 SQL로 직접 계산해서 확인한다. 말투는 원래 문제와 같게 한다.";
const EXTRA = {
  blank: "빈칸에는 원래 객관식의 정답에 해당하는 결과 값, 행 수, 키워드처럼 풀이가 필요한 답을 둔다.",
  free: "원래 객관식의 정답을 구하고 그 이유를 설명하게 묻는다. keyPoints는 3~5개로 쓴다.",
};

async function main() {
  const db = getDb();
  const concepts = await db.select().from(concept);
  await db.$client.end();
  const title = new Map(concepts.map((c) => [c.id, c.title]));
  const seen = new Set<string>();
  const sources = DEFAULT_QUIZ_PROBLEMS.filter((p) => p.format === "mcq" && !seen.has(p.conceptId) && seen.add(p.conceptId));
  console.log(`절 ${sources.length}개 × 빈칸·서술형 = ${sources.length * 2}문제`);

  const jobs = sources.flatMap((p) => (["blank", "free"] as const).map((format) => ({ p, format })));
  const drafts = await mapLimit(jobs, 3, async ({ p, format }) => {
    const system = [...principles.system, `[${format}] ${principles.formatRules[format]}`, CONVERT, EXTRA[format]].join("\n");
    const sourceText = `<target_section>\n${title.get(p.conceptId)}\n</target_section>\n\n<source_problem>\n${renderProblem(p as unknown as Record<string, unknown>, "mcq")}\n</source_problem>`;
    let feedback = "";
    const history: string[][] = [];
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const r = await withRetryCli(() =>
        callJsonCli({
          model: "claude-opus-5-5",
          effort: "high",
          system,
          content: feedback ? `${sourceText}\n\n<previous_failures>\n앞서 만든 문제가 아래 이유로 탈락했다. 이 점을 고쳐서 다시 만든다.\n${feedback}\n</previous_failures>` : sourceText,
          properties: {
            stem: { type: "string" },
            hint: { type: "string" },
            explanation: { type: "string" },
            answer: { type: "object", properties: SCHEMAS[format], required: Object.keys(SCHEMAS[format]), additionalProperties: false },
          },
          timeoutMs: 300_000,
          maxTokens: 8000,
        }),
      );
      const out = r.value as Record<string, unknown>;
      const auto = autoCheck(out, format);
      const fails: string[] = [];
      if (!auto.parsed) fails.push("parse: 서비스 문제 형식으로 읽히지 않음");
      if (!auto.formatRule) fails.push(`format_rule: ${auto.formatNote}`);
      if (auto.banned.length) fails.push(`banned: 금지 표현 ${auto.banned.join(", ")}`);
      if (!auto.tableOk) fails.push(`table: 표 ${auto.maxTableRows}행(5행 이하여야 함)`);
      if (!fails.length) {
        const j = await judgeCli({
          task: "SQLD 학습 서비스의 퀴즈 문제 하나를 판정한다. 학습자는 학습 화면 없이 문제만 본다. 출제 범위 기준은 문제가 이 절의 내용을 묻는지로 본다.",
          criteria: CRITERIA,
          material: `<target_section>\n${title.get(p.conceptId)}\n</target_section>\n\n<generated_problem>\n${renderProblem(out, format)}\n</generated_problem>`,
        });
        for (const [k, v] of Object.entries(j.items)) if (!v.pass) fails.push(`${k}: ${v.reason}`);
      }
      const id = `${p.conceptId}-${format}`;
      console.log(`${id} ${attempt}회차 ${fails.length ? `✗ ${fails.join(" / ")}` : "✓"}`);
      history.push(fails);
      if (!fails.length || attempt === MAX_TRIES) {
        return { id, conceptId: p.conceptId, format, source: `default:${p.conceptId}:mcq`, ...out, check: { pass: fails.length === 0, attempts: attempt, fails, history } };
      }
      feedback = fails.map((f) => `- ${f}`).join("\n");
    }
    throw new Error("도달하지 않는다");
  });

  const path = join(here, "default-drafts.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        note: "기본 객관식을 같은 표와 SQL로 바꾼 빈칸·서술형 기본 문제 초안이다. v4-blank 원칙으로 만들고 자동 검사와 판정자를 통과했는지 check에 적었다. PO 검수 전이다.",
        drafts,
      },
      null,
      2,
    ),
  );
  const pass = drafts.filter((d) => d.check.pass).length;
  console.log(`통과 ${pass}/${drafts.length}. 저장: ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
