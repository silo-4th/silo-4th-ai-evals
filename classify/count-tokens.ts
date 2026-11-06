// 서비스 흐름의 호출별 입력 토큰을 실제 단원 본문으로 잰다. count_tokens API는 과금되지 않는다.
import { getDb } from "@/lib/db";
import { concept, unit } from "@/lib/db/schema";
import { anthropic } from "@/lib/llm/client";
import { env } from "@/lib/env";

const SAMPLE_Q = "LEFT JOIN 조건을 WHERE에 쓰면 왜 INNER JOIN처럼 돼요?";
// 답 길이 가정: 한국어 설명 약 800자. 실제 출력 토큰은 하네스에서 usage로 잰다.
const SAMPLE_A = "LEFT OUTER JOIN은 왼쪽 테이블의 행을 모두 남기고, 오른쪽에 짝이 없으면 NULL로 채워요. ".repeat(14);
const SUMMARY = "학습자가 LEFT JOIN 조건을 WHERE에 쓰면 결과가 INNER JOIN처럼 되는 이유를 물었고, WHERE가 NULL 행을 걸러 내기 때문이라는 답을 받았다.";

async function count(model: string, system: string | { type: "text"; text: string }[], content: string, history: { role: "user" | "assistant"; content: string }[] = []) {
  const r = await anthropic().messages.countTokens({ model, system, messages: [...history, { role: "user", content }] });
  return r.input_tokens;
}

async function main() {
  const db = getDb();
  const units = (await db.select({ id: unit.id, title: unit.title, content: unit.content }).from(unit)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const concepts = (await db.select({ id: concept.id, title: concept.title }).from(concept)).sort((a, b) => (a.id < b.id ? -1 : 1));

  const classifySystem = "학습자의 질문이 아래 개념 목록의 어느 개념에 대한 질문인지 고른다. 해당하는 개념이 없으면 conceptIds를 비운다. keywords에는 질문의 핵심 용어를 1~5개 넣는다.";
  const classifyContent = `<concepts>\n${concepts.map(({ id, title }) => `${id}: ${title}`).join("\n")}\n</concepts>\n\n<question>\n${SAMPLE_Q}\n</question>`;
  const classify = await count(env.ANTHROPIC_UTILITY_MODEL, classifySystem, classifyContent);

  const summarySystem = "학습자의 질문과 AI의 답을 읽고, 학습자가 무엇을 물었고 어떤 답을 받았는지 한국어 2~3문장, 300자 이내로 요약한다. keywords에는 핵심 용어를 1~5개 넣는다.";
  const summarize = await count(env.ANTHROPIC_UTILITY_MODEL, summarySystem, `<question>\n${SAMPLE_Q}\n</question>\n\n<answer>\n${SAMPLE_A}\n</answer>`);
  const answerTokens = await count(env.ANTHROPIC_UTILITY_MODEL, "", SAMPLE_A).catch(() => NaN);

  console.log(JSON.stringify({ concepts: concepts.length, classify, summarize, sampleAnswerChars: SAMPLE_A.length, sampleAnswerTokensApprox: answerTokens }));

  const head = "학습자가 아래 단원을 읽다가 질문했다. 단원 내용을 바탕으로 한국어로 답한다.";
  const past = `학습자가 전에 비슷한 내용으로 물었던 질문의 요약이다. 이어지는 질문이면 참고해 답한다.\n<past_questions>\n${Array(5).fill(`- ${SUMMARY}`).join("\n")}\n</past_questions>`;
  const turn = (n: number) => Array.from({ length: n }, () => [
    { role: "user" as const, content: SAMPLE_Q },
    { role: "assistant" as const, content: SAMPLE_A },
  ]).flat();

  for (const u of units) {
    const sys = [{ type: "text" as const, text: head }, { type: "text" as const, text: `<unit>\n${u.content}\n</unit>` }];
    const base = await count(env.ANTHROPIC_MODEL, sys, SAMPLE_Q);
    const withPast = await count(env.ANTHROPIC_MODEL, [...sys, { type: "text" as const, text: past }], SAMPLE_Q);
    const turn5 = await count(env.ANTHROPIC_MODEL, sys, SAMPLE_Q, turn(5));
    console.log(JSON.stringify({ unit: u.id, title: u.title, chars: u.content.length, answerBase: base, answerWith5Past: withPast, answerAfter5Turns: turn5 }));
  }
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
