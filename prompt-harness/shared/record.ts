// 결과 기록과 통계. 트랙 하네스가 results/에 JSON과 마크다운을 남길 때 쓴다.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// run.sh가 넣어 준 develop 커밋 해시다.
export const commitInfo = () => ({ head: process.env.HARNESS_COMMIT ?? "?", originDevelop: process.env.HARNESS_ORIGIN ?? "?" });

export const stamp = () => new Date().toISOString().replaceAll(":", "-").slice(0, 19);

export const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
export const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
export const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);
export const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "-");

// 3번 돌린 값의 평균과 최솟값을 "평균 (최소)" 형태로 적는다.
export const meanMin = (xs: number[], digits = 1) =>
  xs.length ? `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(digits)} (최소 ${Math.min(...xs).toFixed(digits)})` : "-";

export const cell = (text: unknown) => String(text ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");

export function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(없음)";
  const keys = Object.keys(rows[0]);
  return [`| ${keys.join(" | ")} |`, `|${keys.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${keys.map((k) => cell(r[k])).join(" | ")} |`)].join(
    "\n",
  );
}

export function writeResults(dir: string, name: string, data: unknown, markdown: string) {
  const outDir = join(dir, "results");
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, name);
  writeFileSync(`${base}.json`, JSON.stringify(data, null, 2));
  writeFileSync(`${base}.md`, markdown);
  return `${base}.md`;
}

// 사람 검수 목록: 무작위 n건과 실패로 본 건 전부. seed를 고정해 다시 뽑아도 같은 목록이 나오게 한다.
export function sampleForReview<T>(rows: T[], isFail: (r: T) => boolean, n = 10, seed = 42) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const passed = rows.filter((r) => !isFail(r));
  const shuffled = [...passed].sort(() => rand() - 0.5);
  return { random: shuffled.slice(0, n), failed: rows.filter(isFail) };
}
