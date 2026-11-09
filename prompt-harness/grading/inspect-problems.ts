// DB의 서술형 문제를 확인하는 스크립트다. 입력 세트를 만들 때만 쓴다.
// 사용법: sh shared/run.sh grading/inspect-problems.ts <출력 JSON 경로>
import { writeFileSync } from "node:fs";
import { getDb } from "@/lib/db";
async function main() {
  const db = getDb();
  const q = async (text: string) => (await db.$client.query(text)).rows;
  const counts = await q("select format, (learner_id is null) as is_default, (retired_at is null) as active, count(*)::int as n from quiz_problems group by 1,2,3 order by 1,2,3");
  console.log(counts);
  const free = await q("select id, learner_id, concept_id, stem, answer, hint, explanation, retired_at from quiz_problems where format = 'free' order by learner_id nulls first, created_at");
  const rows = free;
  const concepts = await q("select id, title from concepts");
  await db.$client.end();
  writeFileSync(process.argv[2], JSON.stringify({ free: rows, concepts: concepts }, null, 1));
  console.log("free rows", rows.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
