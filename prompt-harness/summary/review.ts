// 사람 검수 목록을 만든다. 버전마다 AI 판정을 통과한 행에서 무작위 10건, AI가 실패로 본 행 전부를 뽑는다.
// 사용법(summary/ 폴더에서): sh ../shared/run.sh review.ts <출력.md> <결과.json> [결과.json ...] --versions baseline,v2-slots
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sampleForReview } from "../shared/record";

type Judged = Record<string, { pass: boolean; reason: string }>;
type Row = { run: number; id: string; summary: string; keywords: string[]; chars: number; sentences: number; error?: string; judged?: Judged };
type Follow = { id: string; followup: string; summary: string; withOriginal: string; withSummary: string; judged?: Judged };
type Result = { prompt: { name: string }; rows: Row[]; follow?: Follow[] };

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const vIndex = args.indexOf("--versions");
const versions = vIndex >= 0 ? args[vIndex + 1].split(",") : undefined;
const [out, ...files] = args.filter((_, i) => i !== vIndex && i !== vIndex + 1);
// 본 입력과 보조 입력(짧은 답)을 함께 읽는다. ID가 겹치지 않는다.
const pairs = new Map(
  ["inputs.json", "inputs-short.json"]
    .filter((f) => existsSync(join(here, f)))
    .flatMap((f) => JSON.parse(readFileSync(join(here, f), "utf8")) as { id: string; question: string; answer: string }[])
    .map((p) => [p.id, p]),
);
const results: Result[] = files.flatMap((f) => (JSON.parse(readFileSync(f, "utf8")) as { results: Result[] }).results);
const picked = versions ? versions.map((v) => results.find((r) => r.prompt.name === v)!).filter(Boolean) : results;

const LABEL: Record<string, string> = { intent: "질문 의도", confusion: "헷갈린 지점", conclusion: "답의 핵심 결론", faithful: "충실성", continuity: "후속 질문 이어짐" };
const failed = (r: Row) => !!r.judged && Object.values(r.judged).some((j) => !j.pass);
const quote = (t: string) => t.split("\n").map((l) => `> ${l}`).join("\n");

function rowBlock(r: Row, n: number) {
  const p = pairs.get(r.id)!;
  return [
    `#### ${n}. ${r.id} (${r.run}회차)`,
    "",
    `- 질문: ${p.question.replaceAll("\n", " ")}`,
    `- 요약(${r.chars}자, ${r.sentences}문장): ${r.summary}`,
    `- keywords: ${r.keywords.join(", ")}`,
    `- AI 판정: ${Object.entries(r.judged ?? {}).map(([k, j]) => `${LABEL[k] ?? k} ${j.pass ? "통과" : "실패"}(${j.reason})`).join(" / ")}`,
    `- PO 판단: [ ] AI 판정에 동의 [ ] 동의하지 않음(이유: )`,
    "",
    "<details><summary>AI 답 원문</summary>",
    "",
    quote(p.answer),
    "",
    "</details>",
    "",
  ].join("\n");
}

const md: string[] = [
  "# 요약 프롬프트 사람 검수 목록 (2026-11-08)",
  "",
  "AI 판정자(Opus 5.5)도 틀릴 수 있으므로, 판정 결과 일부를 PO가 직접 확인한다. 버전마다 AI가 통과로 본 요약에서 무작위 10건을 뽑고, AI가 하나라도 실패로 본 요약은 전부 넣었다.",
  "각 항목의 \"PO 판단\" 칸에 AI 판정에 동의하는지 표시한다. 동의하지 않는 항목이 많으면 판정 기준표를 고친 뒤 다시 돌린다.",
  "",
];
for (const res of picked) {
  const { random, failed: bad } = sampleForReview(res.rows.filter((r) => !r.error), failed, 10);
  md.push(`## ${res.prompt.name}`, "", `### 무작위 10건 (AI 판정 통과)`, "");
  random.forEach((r, i) => md.push(rowBlock(r, i + 1)));
  md.push(`### AI가 실패로 본 요약 전부 (${bad.length}건)`, "");
  bad.forEach((r, i) => md.push(rowBlock(r, i + 1)));
  const fb = (res.follow ?? []).filter((f) => f.judged && !f.judged.continuity.pass);
  if (res.follow) {
    md.push(`### 후속 질문 시험에서 AI가 실패로 본 건 (${fb.length}/${res.follow.length}건)`, "");
    fb.forEach((f, i) =>
      md.push(
        [
          `#### ${i + 1}. ${f.id}`,
          "",
          `- 앞 질문: ${pairs.get(f.id)!.question}`,
          `- 요약: ${f.summary}`,
          `- 후속 질문: ${f.followup}`,
          `- AI 판정: ${f.judged!.continuity.reason}`,
          `- PO 판단: [ ] AI 판정에 동의 [ ] 동의하지 않음(이유: )`,
          "",
          "<details><summary>원문 대화를 넣고 받은 답</summary>",
          "",
          quote(f.withOriginal),
          "",
          "</details>",
          "",
          "<details><summary>요약만 넣고 받은 답</summary>",
          "",
          quote(f.withSummary),
          "",
          "</details>",
          "",
        ].join("\n"),
      ),
    );
  }
}
writeFileSync(out, md.join("\n"));
console.log(out);
