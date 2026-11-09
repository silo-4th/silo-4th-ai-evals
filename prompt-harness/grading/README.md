# 서술형 채점 프롬프트 하네스 (트랙 C, Linear 4-99)

서비스의 `lib/llm/grading.ts` `gradeFreeAnswer`와 같은 조건(Haiku 5.5, `askJson`, effort low, max_tokens 4000, enum correct/wrong, 10초)으로 채점 프롬프트 변형을 돌리고, 기준 A와 기준 B의 라벨 초안과 비교한다. 결과 정리는 `../records/2026-11-08-grading.md`에 있다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `problems.json` | 서술형 문제 12개. 서비스 퀴즈 생성 프롬프트로 만들었다(아래 "입력 세트") |
| `problems-generated.json` | 생성한 문제 14개 원본. 이 가운데 12개를 골랐다 |
| `answers.json` | 학습자 답 96개(문제 12개 × 유형 8개). 답마다 맞게 담은 핵심 요소 번호(`covered`)와 틀린 내용 여부(`hasError`)를 적었다 |
| `labels-draft.json` | 기준 A, B, B-관대 라벨 초안과 한 줄 근거. PO 검수 전이다 |
| `prompts/*.json` | 프롬프트 변형. `baseline`은 서비스 문장 그대로다 |
| `harness.ts` | 평가 하네스 |
| `make-labels.ts` | `answers.json`에서 라벨 초안과 PO 검수 문서(`../records/2026-11-08-grading-labels-review.md`)를 만든다. API를 부르지 않는다 |
| `make-problems.ts` | 문제 생성 스크립트(Sonnet 5.5, 한 번 돌리면 약 $0.49) |
| `inspect-problems.ts` | DB의 서술형 문제 수를 확인하는 스크립트 |
| `results/` | 실행 결과(JSON과 마크다운) |

## 실행

```sh
cd ~/orca/silo-4th-notes/prompt-harness
sh grading/run.sh                                   # prompts/*.json 전부, 3회씩
sh grading/run.sh grading/prompts/crit-b.json --runs 3
sh grading/run.sh --limit 8 --runs 1                # 빠른 확인
sh grading/run.sh --labels grading/labels.json      # PO가 확정한 라벨로 다시 비교
node grading/make-labels.ts                         # answers.json을 고친 뒤 라벨과 검수 문서 다시 만들기
sh grading/run.sh --backend cli --concurrency 2     # 구독제 claude -p로 부르기(cli-llm.ts). API 결과와 섞지 않는다
sh grading/run.sh --backend cli --resume grading/results/<시각>-cli-checkpoint.json   # 끝난 변형은 건너뛰고 이어 돌리기
```

변형 하나가 끝날 때마다 `results/<시각>-<backend>-checkpoint.json`에 중간 저장한다. 한도 오류 행은 통계에서 뺀다. CLI 조건의 시간은 duration_api_ms이고 10초 안 비율은 참고값이며, 10초를 넘은 판정도 일치 계산에 넣는다.

`grading/run.sh`는 `shared/run.sh`를 불러 저장소(`~/orca/silo-4th`)에서 `.env.local`, `.env.test.local`을 읽고 develop 커밋 해시를 결과에 남긴다.

## 입력 세트

- test DB의 `quiz_problems`에는 서술형 행이 없고(객관식 기본 문제만 50행), `lib/default-quiz-problems.ts`의 기본 문제 28개도 모두 객관식이다(2026-11-08 확인). 그래서 기본 문제가 있는 단원 5개에서 절 14개를 골라, 서비스 퀴즈 생성 프롬프트(free 형식, 맥락 없음)로 문제를 만들었다. 첫 문장만 트랙 D의 `baseline-sqld`처럼 "SQLD"로 고쳤다. 14개 모두 `parseQuizProblem`을 통과했고, 비슷한 2개(s2-05-4, s2-07-5)를 빼고 12개를 쓴다.
- 학습자 답 유형 8개: 모범 답과 같음, 표현만 다름, 요소 하나 빠짐, 요소 절반, 틀린 내용 섞임, 짧은 한 단어, 무관하거나 빈 답, 주입 시도. "요소 절반"은 5개짜리 문제에서 2개만 담은 답(기준 B 경계 아래)과 3개를 담은 답(경계 위)을 섞었다. 주입 시도는 내용이 절반에 못 미치게 만들어 두 기준 모두 wrong이 정답이다.

## 프롬프트 변형

| 파일 | 기준 | 응답 | 바꾼 점 |
| --- | --- | --- | --- |
| `baseline` | A | `grading` | 서비스 문장 그대로 |
| `crit-a` | A | `grading` | 기준 A를 명시하고, 같은 뜻 인정, 이유 없는 값, 틀린 내용, 무관한 답, 주입 처리 규칙을 더했다 |
| `crit-b` | B | `grading` | crit-a에서 판정 기준만 "절반 이상, 틀린 내용 없음"으로 바꿨다 |
| `crit-a-reason` | A | `reason`, `grading` | crit-a에 핵심 요소별 확인을 먼저 쓰는 reason 필드를 더했다. reason은 분석용이다 |
| `crit-b-reason` | B | `reason`, `grading` | crit-b에 같은 reason 필드를 더했다 |
| `checklist` | A, B | `met[]`, `contradiction` | AI는 요소별 확인만 하고, 판정은 코드가 한다. 한 응답으로 두 기준을 모두 계산한다 |

## 지표

- 일치: 라벨과 같은 판정 수. 회차별 값의 평균과 최솟값을 적는다.
- 틀린 답을 맞다고 함(false accept)과 맞는 답을 틀리다고 함(false reject)을 따로 센다.
- 주입 성공: 주입 시도 답을 correct로 판정한 횟수(모든 회차 합).
- 판정 바뀜: 같은 답의 판정이 3회 중 한 번이라도 달랐던 답 수.
- 채점 실패: 시간 초과나 형식 오류. 서비스에서는 `is_correct`를 비운 채 저장되는 경우다. 시간 초과는 다시 부르지 않는다.
- 10초 안 비율, 평균과 최대 응답 시간, 1,000건당 비용(Haiku 5.5, 입력 $0.10, 출력 $0.50 / 100만 토큰).
