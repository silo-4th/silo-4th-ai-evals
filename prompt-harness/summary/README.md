# 질문 요약 프롬프트 하네스 (트랙 B)

서비스의 질문 요약 프롬프트(`lib/llm/tagging.ts`의 `summarizeQuestion`)를 여러 버전으로 바꿔 가며, 같은 질문과 답 쌍으로 품질, 응답 시간, 비용을 비교한다.
요약은 두 곳에 쓰이므로 그 쓰임새를 기준으로 평가한다.

1. 다음 질문의 답변 프롬프트에 `<past_questions>`로 들어간다(`lib/llm/answer.ts`의 `pastQuestionsBlock`).
2. 퀴즈 탭 문제 생성에 `<conversation_summaries>`로 들어가 학습자가 헷갈린 지점을 알려 준다(`lib/llm/quiz-generation.ts`).

## 실행

이 폴더에서 아래 명령을 실행한다. 공통 실행기 `../shared/run.sh`가 저장소로 옮겨 가서 env 파일을 읽고 develop 커밋 해시를 기록한다.

```bash
sh run.sh                                                    # baseline을 3번 돌리고 Opus로 판정한다
sh run.sh prompts/baseline.json prompts/v2-slots.json        # 두 버전을 같은 입력으로 비교한다
sh run.sh prompts/v2-slots.json --runs 1 --limit 5 --no-judge # 판정 없이 빠르게 시험한다
sh run.sh prompts/v2-slots.json --followup 12                # 후속 질문 시험을 함께 한다
```

결과는 `results/`에 실행 시각을 이름으로 한 `.md`와 `.json`으로 쌓인다. 회차가 끝날 때마다 `<시각>-<버전>-partial.json`도 저장한다. API 사용 한도 초과처럼 다시 불러도 소용없는 오류가 나면 남은 호출을 멈추고 그때까지의 결과를 저장한다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `prompts/*.json` | 시험할 프롬프트. `baseline.json`은 서비스가 지금 쓰는 프롬프트와 같다 |
| `inputs.json` | 고정한 입력 세트 79쌍. test DB의 실제 질문 12쌍(`db-*`)과 서비스 답변 프롬프트로 답을 만든 67쌍(`gen-*`)이다 |
| `inputs-short.json` | 보조 입력 20쌍. 트랙 A의 짧은 답 변형(v1-concise, 평균 257자) 1회차 답이다. 짧은 답에서도 요약이 잘 되는지 본다(`--inputs inputs-short.json`) |
| `inputs-fast.json` | 빠른 반복용 30쌍. 지금까지 두 번 이상 실패했거나 추천 버전이 실패한 14쌍과 무작위 16쌍이다. `--inputs inputs-fast.json --runs 2 --criteria conclusion,faithful,confusion`으로 쓴다 |
| `labels-draft-kw.json` | keywords 자동 검사용 입력 분류 초안(무관한 입력은 0개, 애매한 입력은 0~5개, 나머지는 1~5개). 11/8 PO 결정을 반영했고, 분류 자체는 PO 검수 전이다 |
| `followups.json` | 후속 질문 시험에 쓰는 후속 질문 12개. 입력 쌍 ID에 연결돼 있다 |
| `build-inputs.ts` | `inputs.json`을 만든 스크립트. 다시 돌리면 답이 바뀌므로, 버전 비교 중에는 돌리지 않는다 |
| `harness.ts` | 요약을 만들고 자동 검사와 AI 판정을 하는 본체 |
| `review.ts` | 결과 JSON에서 사람 검수 목록을 뽑는 스크립트 |

## 프롬프트 파일 형식

`{ "name", "description", "system", "user" }`이다. `user` 안의 `{{QUESTION}}`과 `{{ANSWER}}`가 질문과 답으로 바뀐다. baseline의 `user`는 서비스와 똑같이 `<question>`과 `<answer>`로 감싼다.

## 측정 항목

| 항목 | 방법 |
| --- | --- |
| 300자 이내, 2~3문장, keywords 기준 | 자동 검사. keywords는 `labels-draft-kw.json` 분류에 따라 0개, 0~5개, 1~5개로 판정한다. 문장은 `.`, `?`, `!` 뒤에 공백이나 끝이 오면 하나로 센다 |
| intent: 질문 의도를 담았는가 | Opus 판정 |
| confusion: 학습자가 헷갈린 지점을 퀴즈 출제자가 알아볼 수 있는가 | Opus 판정 |
| conclusion: 답의 핵심 결론(규칙, 결과값, 차이점)이 들어 있는가 | Opus 판정 |
| faithful: 원문에 없거나 틀린 내용이 없는가 | Opus 판정 |
| 후속 질문 이어짐(선택) | 같은 후속 질문을 원문 대화를 넣어 답하게 한 결과와 요약만 `<past_questions>`로 넣어 답하게 한 결과를 Opus가 비교한다. 1회차 요약으로 1번만 돈다 |
| 시간, 비용 | 측정. 비용은 `../shared/cost.ts` 가격표로 계산한다 |

## 주의

- 호출 설정은 `askJson`과 같다(Haiku 5.5, effort low, max_tokens 4000, JSON 스키마, 30초). 서비스 설정이 바뀌면 `../shared/llm.ts`를 맞춘다.
- 판정 비용이 요약 비용보다 훨씬 크다. 79쌍 × 3회 판정에 약 $5가 든다.
- AI 판정도 틀릴 수 있으므로, 결과는 `records/`의 사람 검수 목록으로 PO가 확인한다.
