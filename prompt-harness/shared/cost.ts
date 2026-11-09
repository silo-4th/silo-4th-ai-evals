// 100만 토큰당 가격(공식 가격표 기준)이다. HANDOFF.md "가격과 비용 계산"과 같게 둔다.
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });

// 캐시에 쓰는 입력은 1.25배, 캐시에서 읽는 입력은 0.1배로 계산한다. inputTokens에는 캐시 토큰이 들어 있지 않다(API 기준).
export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`가격표에 없는 모델이다: ${model}`);
  return (
    (u.inputTokens * p.input + u.cacheWriteTokens * p.input * 1.25 + u.cacheReadTokens * p.input * 0.1 + u.outputTokens * p.output) /
    1_000_000
  );
}

// 1,000건당 비용(달러)이다.
export const per1000 = (model: string, usages: Usage[]) =>
  usages.length ? Number(((usages.reduce((a, u) => a + costUsd(model, u), 0) / usages.length) * 1000).toFixed(3)) : 0;
