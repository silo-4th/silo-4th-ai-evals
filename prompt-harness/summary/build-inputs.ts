// 요약 하네스의 입력 세트(질문과 답 쌍)를 한 번 만들어 inputs.json에 고정한다. 모든 변형이 같은 쌍을 쓴다.
// 사용법: sh ../shared/run.sh build-inputs.ts   (summary/ 폴더에서)
// 1) test DB에서 status='ok'이고 assistant 메시지가 있는 질문을 모두 읽는다(실제 학습자 입력).
// 2) 그것만으로는 모자라서, classify-harness/questions-single.json에서 고르게 67개를 골라 서비스 답변 프롬프트로 답을 만든다.
//    답변 호출은 streamAnswer와 같다: Sonnet, 스트리밍, effort low, 단원 본문에 cache_control, 앞 대화와 과거 요약 없음.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "@/lib/db";
import { concept, unit } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { mapLimit, streamText, withRetry } from "../shared/llm";
import { costUsd, type Usage } from "../shared/cost";

const { sql } = createRequire("/Users/banjax.index/orca/silo-4th/package.json")("drizzle-orm") as typeof import("drizzle-orm");
const here = dirname(fileURLToPath(import.meta.url));
const GENERATED = 67;

export type Pair = { id: string; source: "db" | "generated"; unitId: string; question: string; answer: string; note?: string };

async function main() {
  const db = getDb();
  const units = new Map((await db.select().from(unit)).map((u) => [u.id, u.content]));
  const concepts = new Map((await db.select({ id: concept.id, unitId: concept.unitId }).from(concept)).map((c) => [c.id, c.unitId]));
  const dbRows = (
    await db.execute(sql`
      select q.id, q.unit_id, m.content as question, a.content as answer
      from questions q
      join messages m on m.question_id = q.id and m.seq = 1
      join messages a on a.question_id = q.id and a.role = 'assistant'
      where q.status = 'ok' order by q.asked_at`)
  ).rows as { id: string; unit_id: string; question: string; answer: string }[];
  const pairs: Pair[] = dbRows.map((r, i) => ({ id: `db-${i + 1}`, source: "db", unitId: r.unit_id, question: r.question, answer: r.answer }));

  const all: { question: string; expected: string[]; note?: string }[] = JSON.parse(
    readFileSync(join(here, "../../classify-harness/questions-single.json"), "utf8"),
  );
  const picked = Array.from({ length: GENERATED }, (_, i) => all[Math.floor((i * all.length) / GENERATED)]);
  const usages: Usage[] = [];
  const generated = await mapLimit(picked, 4, async (c, i) => {
    const unitId = concepts.get(c.expected[0]) ?? "s2-05";
    const r = await withRetry(() =>
      streamText({
        model: env.ANTHROPIC_MODEL,
        system: [
          { type: "text", text: "학습자가 아래 단원을 읽다가 질문했다. 단원 내용을 바탕으로 한국어로 답한다." },
          { type: "text", text: `<unit>\n${units.get(unitId)}\n</unit>`, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: c.question }],
      }),
    );
    usages.push(r.usage);
    process.stdout.write(".");
    return { id: `gen-${i + 1}`, source: "generated" as const, unitId, question: c.question, answer: r.value, note: c.note };
  });
  pairs.push(...generated);
  await db.$client.end();
  writeFileSync(join(here, "inputs.json"), JSON.stringify(pairs, null, 1));
  const spent = usages.reduce((a, u) => a + costUsd(env.ANTHROPIC_MODEL, u), 0);
  console.log(`\n쌍 ${pairs.length}개(db ${dbRows.length}, 생성 ${generated.length}), 답 생성 비용 $${spent.toFixed(3)}, 모델 ${env.ANTHROPIC_MODEL}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
