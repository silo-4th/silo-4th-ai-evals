// 사람 검수 목록을 만든다. 실패한 건 전부(AI 판정 실패 또는 자동 검사 실패)와, 나머지 중 무작위 10건을 뽑는다.
// AI 판정이 없는 행(판정 호출 실패 등)도 생성된 문제가 있으면 목록에 넣고, 판정 칸은 "판정 없음"으로 적는다.
// 사용법: sh ../shared/run.sh quiz-generation/review.ts <출력 md> <결과 JSON ...>
// API를 부르지 않는다. 결과 JSON은 harness.ts가 results/에 남긴 파일이다.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { sampleForReview } from "../shared/record";
import { CRITERIA, JUDGE_KEYS, renderProblem, type Row } from "./harness";

type Item = Row & { version: string; file: string; condition: string };

const LABEL: Record<string, string> = {
  scope: "출제 범위",
  answer_correct: "정답 하나·맞음",
  self_contained: "문제만으로 풀이",
  hint_no_leak: "힌트 안전",
  explanation_correct: "해설 맞음",
  sqld_fit: "SQLD 적합",
};
const CONTEXT: Record<string, string> = { summaries: "요약 여러 개(퀴즈 탭)", conversation: "질문과 답 원문(관련 문제)", none: "맥락 없음" };
const FORMAT: Record<string, string> = { mcq: "객관식", blank: "빈칸", free: "서술형" };

// 결과 파일의 backend(생성 경로)와 판정 경로로 측정 조건을 적는다. 조건이 다른 결과를 한 목록에 넣어도 섞여 보이지 않게 한다.
// --judge-only로 API 생성 출력을 CLI로 판정한 파일은 backend가 cli지만 생성은 API다(파일 이름에 api-judged를 붙였다).
const conditionOf = (file: string, backend?: string) =>
  file.includes("api-judged") ? "API 생성 + CLI 판정" : backend === "cli" ? "구독제 CLI 조건" : "API 조건";

function main() {
  const [out, ...files] = process.argv.slice(2);
  const items: Item[] = files.flatMap((f) => {
    const data = JSON.parse(readFileSync(f, "utf8")) as { backend?: string; results: { prompt: { name: string }; rows: Row[] }[] };
    const condition = conditionOf(basename(f), data.backend);
    return data.results.flatMap(({ prompt, rows }) => rows.map((r) => ({ ...r, version: prompt.name, file: basename(f), condition })));
  });
  const generated = items.filter((r) => r.output);
  const autoFail = (r: Item) => !!r.auto && (!r.auto.parsed || !r.auto.formatRule || r.auto.banned.length > 0 || !r.auto.tableOk);
  const isFail = (r: Item) => autoFail(r) || (!!r.judge && JUDGE_KEYS.some((k) => !r.judge![k]?.pass));
  const { random, failed } = sampleForReview(generated, isFail, 10);
  const judgedCount = generated.filter((r) => r.judge).length;

  const block = (r: Item, n: number) => {
    const fails = r.judge ? JUDGE_KEYS.filter((k) => !r.judge![k]?.pass) : [];
    const autoIssues = [
      !r.auto?.parsed && "서비스 모양 검사 실패",
      r.auto?.banned.length && `금지 표현: ${r.auto.banned.join(", ")}`,
      r.auto && !r.auto.tableOk && `표 ${r.auto.maxTableRows}행`,
    ].filter(Boolean);
    return [
      `### ${n}. ${r.caseId} · ${r.version} · ${r.run}회차 · ${r.condition}`,
      "",
      `- 절: ${r.conceptId} ${r.sectionTitle}`,
      `- 형식: ${FORMAT[r.format]}, 맥락: ${CONTEXT[r.context]}`,
      autoIssues.length ? `- 자동 검사: ${autoIssues.join(", ")}` : "- 자동 검사: 통과",
      "",
      "````text",
      renderProblem(r.output!, r.format),
      "````",
      "",
      ...(r.judge
        ? [
            "| 항목 | AI 판정 | 근거 |",
            "|---|---|---|",
            ...JUDGE_KEYS.map((k) => `| ${LABEL[k]} | ${r.judge![k]?.pass ? "통과" : "**실패**"} | ${String(r.judge![k]?.reason ?? "").replaceAll("|", "\\|")} |`),
          ]
        : [`AI 판정: 없음(${r.judgeError ? "판정 호출이 API 사용 한도에 걸려 실패했습니다" : "판정하지 않았습니다"}). 아래 항목을 직접 확인해 주세요: ${JUDGE_KEYS.map((k) => LABEL[k]).join(", ")}.`]),
      "",
      !r.judge
        ? `PO 확인: ${JUDGE_KEYS.map((k) => `${LABEL[k]} [ ] 통과 [ ] 실패`).join(" / ")}`
        : fails.length
        ? `PO 확인: AI 판정이 맞는가? ${fails.map((k) => `${LABEL[k]} [ ] 맞음 [ ] 틀림`).join(" / ")}`
        : "PO 확인: 모든 항목 통과 판정이 맞는가? [ ] 맞음 [ ] 틀림(틀린 항목: )",
      "",
    ].join("\n");
  };

  const byVersion = new Map<string, number>();
  for (const r of failed) {
    const key = `${r.version}(${r.condition})`;
    byVersion.set(key, (byVersion.get(key) ?? 0) + 1);
  }
  const md = [
    "# 퀴즈 생성 사람 검수 목록 (2026-11-08)",
    "",
    judgedCount
      ? "AI 판정자(Opus 5.5)도 틀릴 수 있어서, 판정 결과를 사람이 확인할 목록을 뽑았습니다. 각 문제 아래의 칸에 판정이 맞는지 표시해 주시면 됩니다."
      : "이번 실행은 API 사용 한도에 걸려 AI 판정을 한 건도 받지 못했습니다. 그래서 생성된 문제를 사람이 직접 판정할 수 있도록, 자동 검사에 실패한 문제 전부와 나머지 중 무작위 10건을 뽑았습니다. 각 문제 아래의 칸에 항목별 통과 여부를 표시해 주시면 됩니다.",
    "",
    `- 대상 결과 파일: ${files.map((f) => `\`${basename(f)}\``).join(", ")}`,
    `- 판정 기준: ${CRITERIA.map((c) => `${LABEL[c.key]}(${c.key})`).join(", ")}`,
    `- 생성된 문제 ${generated.length}건 중 AI 판정을 받은 문제는 ${judgedCount}건입니다.`,
    `- A. 실패가 없는 문제 중 무작위 ${random.length}건(seed 42로 고정)`,
    `- B. 자동 검사나 AI 판정에서 하나 이상 실패한 문제 전부 ${failed.length}건${failed.length ? `: ${[...byVersion].map(([v, n]) => `${v} ${n}건`).join(", ")}` : ""}`,
    "- 입력의 맥락(요약, 대화)은 AI가 쓴 초안이며 실제 학습자 기록이 아닙니다.",
    "- 문제마다 제목 끝에 측정 조건을 적었습니다. \"API 생성\"은 서비스와 같은 호출로 만든 문제이고, \"구독제 CLI 조건\"은 서비스와 다른 호출 경로로 만든 문제입니다. 시간이 부족하면 API 생성 문제부터 보시면 됩니다.",
    "",
    "## A. 무작위 검수",
    "",
    ...random.map((r, i) => block(r, i + 1)),
    "## B. 실패 전부",
    "",
    ...failed.map((r, i) => block(r, i + 1)),
  ].join("\n");
  writeFileSync(out, md);
  console.log(`무작위 ${random.length}건, 실패 ${failed.length}건 → ${out}`);
}

main();
