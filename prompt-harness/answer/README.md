# 답변 프롬프트 하네스 (트랙 A)

학습자 질문에 답하는 프롬프트(`lib/llm/answer.ts`의 `streamAnswer`)를 여러 버전으로 바꿔 가며, 같은 사례 세트로 품질, 길이, 응답 시간, 비용을 비교한다.

## 실행

이 폴더에서 아래 명령을 실행한다.

```bash
sh run.sh                                                   # baseline을 3회 실행
sh run.sh prompts/v1-concise.json prompts/v3-grounded.json  # 여러 버전을 같은 사례로 차례로 실행
sh run.sh prompts/v3-grounded.json --runs 1 --kinds oos     # 유형을 골라 1회만 실행
sh run.sh prompts/baseline.json --ids s001,past10 --no-judge # 사례를 골라 판정 없이 실행
sh run.sh --report results/baseline-....json results/v3-grounded-....json  # 이미 돌린 결과로 비교표만 다시 만들기
```

실행 환경(.env 파일, develop 커밋 해시)은 `../shared/run.sh`가 맞춘다. 결과는 `results/`에 `<버전>-<시각>.json/.md`, 사람 검수 목록 `<버전>-<시각>-review.md`, 비교표 `compare-<시각>.md`로 쌓인다. baseline을 돌리면 트랙 B가 쓸 `results/baseline-pairs.json`(첫 실행의 질문과 답 쌍)도 만든다.

## 구독제로 실행하기 (`--backend cli`)

2026-11-08에 API 워크스페이스 사용 한도(12/1 해제)에 걸린 뒤로는 구독 로그인(claude.ai)으로 `claude -p`를 불러 실행한다. `cli-llm.ts`가 이 경로이고, 트랙 D의 `../quiz-generation/cli-llm.ts`를 답변용으로 고쳐 옮겼다.

```bash
sh run.sh prompts/v3-grounded.json --backend cli --runs 3   # 동시 실행 기본값은 3이다
```

| 항목 | 서비스(streamAnswer) | `--backend cli` |
| --- | --- | --- |
| 모델, effort, 스트리밍 | Sonnet 5.5, low, 스트리밍 | 같음 |
| system | 블록 3개(지시문, `<unit>`, 과거 요약) | 같은 문장을 줄바꿈 두 개로 이어 한 문자열로 넘긴다(`--system-prompt`로 Claude Code 기본 프롬프트를 통째로 바꾼다) |
| 캐시 | 단원 블록에 5분 cache_control | CLI가 system과 메시지 전체에 1시간 캐시를 스스로 건다. 결과의 cache 토큰을 그대로 기록한다 |
| 앞 대화 | messages에 앞 질문과 답을 넣는다 | CLI는 assistant 턴을 그대로 넣지 못한다. 앞 질문을 같은 프롬프트로 실제로 답하게 한 뒤 이번 질문을 보낸다(`--input-format stream-json`). 앞 답은 AI 초안이 아니라 그 버전이 쓴 답이고, 판정자에게도 그 답을 준다. 시간과 토큰은 마지막 턴만 센다 |
| 시간 | 요청부터 첫 글자, 끝까지 | CLI가 요청을 시작한 시점(status requesting)부터 첫 text_delta, result까지. CLI 프로세스 시작 시간은 뺀다 |
| 비용 | API 과금 | 구독이라 실제 과금은 없다. 같은 토큰을 API 가격으로 환산한 참고값이다 |

- 빈 임시 폴더에서 실행하고 도구, MCP, 설정 파일, 슬래시 명령을 끈다. `ANTHROPIC_API_KEY`는 지워서 구독 로그인을 쓰게 한다.
- 판정도 같은 경로로 Opus 5.5를 부른다(`--json-schema`). 단원 본문과 판정 지시문을 이어 한 문자열로 넘긴다.
- 구독 사용량 한도 오류는 30초부터 늘려 가며 다시 시도하고, 세 번 연달아 걸리면 남은 호출을 건너뛴다. 로그 줄 끝에 구독 사용률(5시간 창, 7일 창)을 찍는다.
- API 조건 결과와 CLI 조건 결과는 섞어서 비교하지 않는다. 결과 파일 이름에 `-cli`가 붙는다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `prompts/*.json` | 시험할 프롬프트. `baseline.json`은 서비스가 지금 쓰는 문장 그대로다 |
| `cases.json` | 사례 136건. `build-cases.py`로 만든다 |
| `build-cases.py` | 사례 세트를 만드는 스크립트. AI가 쓴 사례와 기대 행동 초안이 여기에 있다 |
| `harness.ts` | 답을 만들고, Opus 5.5로 판정하고, 결과를 기록하는 본체 |
| `run.sh` | `../shared/run.sh`를 부른다 |

## 프롬프트 파일

`{ name, description, instruction, pastQuestions }` 형식이다.

- `instruction`은 서비스의 첫 system 블록(지시문)이다.
- `pastQuestions`는 과거 질문 요약 블록이다. `{{ITEMS}}`가 `- 요약` 줄 목록으로 바뀐다. baseline은 서비스의 `pastQuestionsBlock` 문장 그대로다.
- system 블록 순서는 서비스와 같다: 지시문, `<unit>` 단원 본문(cache_control), 과거 요약(있을 때만). messages에는 앞 대화와 이번 질문이 들어간다.

## 사례 세트 (`cases.json`, 136건)

| 유형 | 건수 | 출처 | 내용 |
| --- | --- | --- | --- |
| single | 94 | `../../classify-harness/questions-single.json` | 기대 절 ID로 단원을 정한 질문 |
| no-unit | 12 | 같은 파일 | 기대 절이 없는 질문(단원 밖 SQL, SQL과 무관, 맥락 의존). 단원과 기대 행동은 AI 초안이다 |
| oos | 10 | AI 초안 | SQL과 무관한 질문 2, 다른 단원 질문 2, 시험 범위 밖 SQL 1, 프롬프트 주입 5 |
| history | 10 | AI 초안 | 앞 질문과 답이 있는 2턴 대화. 앞 답도 AI가 썼다 |
| past | 10 | AI 초안 | 과거 질문 요약이 있는 질문. 관련 없는 요약 1건, 틀린 요약 1건을 넣었다 |

`expected`(기대 행동)는 모두 `labels-draft`다. PO 검수 전에는 확정 라벨이 아니다. 특히 "단원 밖이지만 SQLD 범위인 질문에 짧게 답한다"는 기준은 PO가 정해야 한다.

`build-cases.py`는 DB의 단원과 절 목록을 덤프한 JSON을 인자로 받는다. 단원 배정에 절 ID와 단원 ID의 대응만 쓴다.

## 판정

Opus 5.5(`claude-opus-5-5`)가 사례마다 아래 기준을 통과/실패로 판정하고 근거를 한 줄로 남긴다. 판정자에게는 단원 본문을 함께 준다.

| 기준 | 질문 | 적용 |
| --- | --- | --- |
| correct 정확성 | 단원 내용과 SQL 문법에 맞는가 | 전부 |
| answered 질문에 답함 | 물은 것에 바로 답했는가, 묻지 않은 내용으로 길어지지 않았는가 | 전부 |
| grounded 단원 근거 | 단원에 없는 내용이나 값을 지어내지 않았는가 | 전부 |
| handling 기대 행동 | 기대 행동 초안대로 처리했는가(단원 밖, 주입, 앞 대화, 과거 요약) | expected가 있는 42건 |

"전 항목 통과"는 적용된 기준을 모두 통과한 비율이다.

판정 지시문과 스키마는 `../shared/judge.ts`와 같다. 다른 점은 단원 본문을 system 맨 앞에 cache_control 블록으로 넣은 것 하나다. 같은 단원을 여러 번 판정하므로 Opus 입력 비용이 크게 줄어든다(`harness.ts`의 `judgeWithUnit`).

## 측정과 비용

- 글자 수는 답 문자열의 글자 수(코드 포인트)다.
- 첫 글자 시간은 요청부터 첫 text_delta까지, 전체 시간은 요청부터 스트림 끝까지다.
- 비용은 `../shared/cost.ts`로 계산한다. 캐시 쓰기 1.25배, 캐시 읽기 0.1배다.
- "1,000건당 $ (실측)"은 하네스에서 실제로 받은 사용량 기준이다. 하네스는 같은 단원 사례를 몰아서 돌리므로 캐시 읽기가 서비스보다 많다. 그래서 단원 본문을 매번 캐시에 새로 쓴다고 가정한 "캐시 미적중 가정" 값도 함께 적는다. 실제 서비스 비용은 두 값 사이에 있다.
- 동시 실행은 4건이다. 429와 5xx는 `withRetry`로 다시 부른다.

## 주의

- 서비스 코드의 `streamAnswer` 설정(모델, effort, max_tokens, 제한 시간, system 블록 순서)이 바뀌면 `../shared/llm.ts`와 `harness.ts`의 `systemBlocks`를 맞춘다.
- 판정자도 틀릴 수 있다. 실행마다 `-review.md`에 무작위 10건과 실패 전부를 뽑아 둔다.
