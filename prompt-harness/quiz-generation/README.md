# 퀴즈 생성 프롬프트 하네스 (트랙 D)

퀴즈 생성 프롬프트(`lib/llm/quiz-generation.ts`의 `SYSTEM`, `FORMAT_RULES`)를 여러 버전으로 바꿔 가며, 같은 입력 세트로 문제 품질, 응답 시간, 비용을 비교한다.

## 실행

이 폴더에서 아래 명령을 실행한다.

```bash
sh run.sh                                                         # baseline 하나로 3회 실행
sh run.sh prompts/baseline.json prompts/baseline-sqld.json        # 두 버전을 같은 입력으로 3회씩 비교
sh run.sh prompts/v1.json --runs 1 --only d01,d08 --tag smoke     # 일부 입력만 1회 실행
sh run.sh prompts/v1.json --no-judge                              # AI 판정 없이 자동 검사만 실행
sh run.sh --judge-only results/<결과>.json                        # 저장된 출력 중 판정이 없는 행만 판정(생성 안 함)
```

생성은 동시 4개(`--concurrency`)로 돌려 응답 시간을 재고, 판정은 생성이 모두 끝난 뒤 동시 10개(`--judge-concurrency`)로 따로 돌린다. 판정의 동시 호출 수는 측정값에 영향을 주지 않는다. `--judge-only`는 자동 검사도 저장된 출력으로 다시 계산한다.

결과는 `results/`에 실행 시각(과 `--tag`)을 이름으로 한 `.md`와 `.json`으로 쌓인다. 회차마다 판정까지 마친 뒤 같은 파일에 덮어써서, 중간에 멈춰도 끝난 회차는 남는다. `.md`에는 비교표와 develop 커밋, 이번 실행에 쓴 API 비용이 적힌다.

사람 검수 목록은 결과 JSON으로 만든다. API를 부르지 않는다.

```bash
cd .. && sh shared/run.sh quiz-generation/review.ts records/<날짜>-quiz-generation-review.md quiz-generation/results/<결과>.json ...
```

## 구독제로 실행하기 (`--backend cli`)

2026-11-08에 API 워크스페이스 사용 한도(12/1 해제)에 걸린 뒤로는 구독 로그인(claude.ai)으로 `claude -p`를 불러 실행한다. `cli-llm.ts`가 이 경로다.

```bash
sh run.sh prompts/baseline-sqld.json --backend cli --runs 3 --judge-concurrency 6
```

서비스와 맞춘 것과 다른 것은 아래와 같다.

| 항목 | 서비스(askJson) | `--backend cli` |
| --- | --- | --- |
| 모델, effort | Sonnet 5.5, low | 같음 |
| system, user content | 서비스 문장 | 같음(`--system-prompt`로 Claude Code 기본 프롬프트를 통째로 바꾼다) |
| 프롬프트 캐시 | 없음 | 없음(`DISABLE_PROMPT_CACHING=1`) |
| JSON 스키마 | `output_config` 엄격 디코딩, 호출 1번 | StructuredOutput 도구 호출. 가끔 CLI가 모델을 한 번 더 부른다(결과표의 "CLI 재호출 수") |
| 입력 토큰 | 프롬프트만 | 도구 정의 등으로 호출마다 약 0.8~0.9k 더 많다 |
| max_tokens | 4000 | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4000`으로 넘기지만 실제 적용은 확인하지 못했다 |
| 응답 시간 | 요청부터 응답까지 | CLI가 알려 주는 `duration_api_ms`(모델 API에 쓴 시간). 30초 제한도 이 값으로 판정한다 |
| 비용 | API 과금 | 구독이라 실제 과금은 없다. 표의 비용은 같은 토큰을 API 가격으로 환산한 값이다 |

- CLAUDE.md와 프로젝트 설정이 섞이지 않게 빈 임시 폴더에서 실행하고, 도구, MCP, 설정 파일, 슬래시 명령을 모두 끈다. `ANTHROPIC_API_KEY`는 지워서 구독 로그인을 쓰게 한다.
- 판정(`judgeCli`)은 `shared/judge.ts`와 같은 system 문장, 스키마, 모델(Opus 5.5), max_tokens 8000으로 부른다.
- 구독 사용량 한도에 세 번 연달아 걸리면 남은 호출을 건너뛴다. 한도 때문에 실패한 행은 프롬프트 실패로 세지 않고 통계에서 뺀다.

## 준비물

- 저장소 `/Users/banjax.index/orca/silo-4th`의 `.env.local`에 `ANTHROPIC_API_KEY`가 있어야 한다.
- 같은 저장소의 `.env.test.local`에 test 브랜치 `DATABASE_URL`이 있어야 한다. 단원 본문(`units.content`)과 절 제목(`concepts.title`)을 여기서 읽는다.
- 저장소에서 `npm install`을 한 번 해 두어야 한다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `prompts/baseline.json` | 서비스가 지금 쓰는 문장 그대로다(develop a2a3970) |
| `prompts/baseline-sqld.json` | baseline에서 "정보처리기사"만 "SQLD"로 고쳤다. 이후 변형은 여기서 시작한다 |
| `prompts/v*.json` | 실패 사례를 보고 만든 변형이다 |
| `cases.json` | 입력 세트 36건(단원 × 절 × 형식 × 맥락)과 맥락 초안 |
| `harness.ts` | 생성, 자동 검사, AI 판정, 결과 기록 본체 |
| `cli-llm.ts` | 구독제 `claude -p` 호출 경로(`--backend cli`) |
| `compare-transfer.py` | 구독제 CLI 조건의 결과를 보정에서 API 조건과 일치한 지표(빈칸, 힌트)로 비교한다. `--only`, `--runs`로 같은 입력과 회차만 고른다 |
| `merge-rerun.py` | 잠자기 같은 외부 원인으로 시간 초과가 난 행을 다시 돌린 행으로 바꾸고, 바꾼 행은 `excludedRows`에 남긴다 |
| `review.ts` | 사람 검수 목록을 만드는 스크립트 |
| `dump-units.ts` | 단원 본문과 절 목록을 내려받는 스크립트(입력 세트를 만들 때만 썼다) |

## 프롬프트 파일 만들기

`prompts/baseline-sqld.json`을 복사해서 `name`, `description`, `system`, `formatRules`를 고친다.

- `system`은 문장 배열이다. 서비스처럼 공백 하나로 잇고, 그 뒤에 형식별 규칙(`formatRules.mcq` 등)을 공백 하나로 붙인다.
- user 메시지는 서비스와 똑같이 조립하므로 프롬프트 파일로 바꿀 수 없다: `<unit_content>`(단원 전체 원문), `<target_section concept_id>`(절 제목), `<format>`, 맥락 블록 순서다.

## 입력 세트

- 5개 단원의 24개 절을 모두 한 번 이상 넣고, 표나 SQL 예제가 많은 절(조인, 그룹 함수, 윈도우 함수)은 두세 번 넣어 36건을 만들었다. 형식은 객관식 15, 빈칸 10, 서술형 11건이다.
- 맥락은 세 가지다: 요약 여러 개(퀴즈 탭, 12건), 질문과 답 원문 하나(관련 문제 풀어보기, 13건), 맥락 없음(기본 문제 생성과 같은 빈 요약 목록, 11건).
- **요약과 대화는 모두 AI가 쓴 초안이다.** 실제 학습자 기록이 아니다. 요약은 단원별 4개로, 서비스의 퀴즈 탭처럼 그 단원의 최근 요약을 흉내 냈다.
- 시험용 사례를 두 개 넣었다. `d13`은 대화 안에 "OX 문제로 내 주세요"라는 지시가 있고(주입), `d20`은 대화가 다른 절(NOT IN과 NULL)로 번진다(출제 범위).

## 측정 항목

| 항목 | 방법 |
| --- | --- |
| 모양 검사 통과 | 서비스의 `parseQuizProblem`을 그대로 import해서 검사 |
| 형식 규칙 | 객관식 보기 2~4개와 정답 위치, 빈칸 `____` 정확히 하나, 서술형 keyPoints 있음 |
| 금지 표현 | 문제, 보기, 힌트, 해설, 모범 답에서 "본문", "위 표", "아래 표", "앞에서", "이 단원", "학습 화면" 등을 찾음 |
| 표 크기 | stem 안 표(코드 블록, SQL 주석 표, 마크다운 표)의 데이터 행이 5행 이하 |
| 출제 범위, 정답, 문제만으로 풀이, 힌트, 해설, SQLD 적합 | Opus 5.5 판정. 단원 원문, 절 제목, 맥락, 문제를 주고 항목마다 통과/실패와 한 줄 근거를 받음 |
| 30초 안 비율, 평균·최대 시간 | 서비스와 같은 30초 제한으로 측정. 시간 초과는 생성 실패로 센다 |
| 1,000건당 비용 | 생성 호출(Sonnet 5.5)만 센다. 판정 비용은 결과 파일의 "이번 실행 비용"에 따로 들어 있다 |

판정 항목의 비율은 생성에 실패한 건도 실패로 센다. "전 항목 통과"는 자동 검사 4개와 AI 판정 6개를 모두 통과한 비율이다.

## 주의

- 호출 설정은 `lib/llm/ask-json.ts`와 `lib/llm/quiz-generation.ts`를 따라 만들었다(`../shared/llm.ts`의 `callJson`). 서비스에서 모델, effort, 스키마, content 조립이 바뀌면 `harness.ts`도 맞춘다.
- 동시 호출은 4개다. 429와 5xx는 다시 부르고, 시간 초과는 다시 부르지 않는다.
- 비용은 HANDOFF의 가격표(Sonnet 5.5 입력 $2, 출력 $10, Opus 5.5 입력 $4, 출력 $20, 100만 토큰당)로 계산한다.
