// 단원 본문과 절 목록을 파일로 내려받는 스크립트다. 입력 세트를 만들 때만 쓴다.
// 사용법: sh ../shared/run.sh quiz-generation/dump-units.ts <출력 JSON 경로>
import { writeFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import { concept, unit } from "@/lib/db/schema";

async function main() {
  const db = getDb();
  const units = await db.select().from(unit);
  const concepts = await db.select().from(concept);
  await db.$client.end();
  writeFileSync(process.argv[2], JSON.stringify({ units, concepts }, null, 1));
  for (const u of units) console.log(u.id, u.title, u.content.length, concepts.filter((c) => c.unitId === u.id).length);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
