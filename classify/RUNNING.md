# 분류 하네스 실행하기

프롬프트를 새로 시험하거나 서비스에 반영한 결과를 다시 잴 때 이 문서를 따라 하네스를 실행합니다. 결과만 확인한다면 [README.md](README.md)를 보세요.

## 사전 준비

1. 서비스 저장소 `silo-4th`를 이 저장소와 같은 폴더에 받아 둡니다. 다른 위치에 받았다면 실행할 때 `SILO_4TH_REPO` 환경 변수로 경로를 지정하세요.
2. 서비스 저장소에서 `npm install`을 실행합니다.
3. 서비스 저장소에 `.env.local`(`ANTHROPIC_API_KEY`)과 `.env.test.local`(test 브랜치 `DATABASE_URL`)을 준비합니다. 하네스는 개념 목록을 이 DB에서 읽습니다.

## 실행

`classify/` 폴더에서 실행합니다. 질문 106개를 프롬프트 하나로 돌리면 약 2분 걸리고, 결과는 `results/`에 `.md`와 `.json`으로 저장됩니다.

```bash
# 두 버전을 같은 질문 세트로 비교합니다.
sh run.sh prompts/baseline.json prompts/single-notes.json --questions questions-single.json

# 서비스 저장소가 다른 위치에 있을 때
SILO_4TH_REPO=/path/to/silo-4th sh run.sh prompts/baseline.json
```

같은 프롬프트도 실행마다 결과가 조금씩 다르므로, 버전을 비교할 때는 2~3번 돌리세요.

## 프롬프트 파일 형식

```json
{
  "name": "single-notes",
  "description": "이 버전에서 바꾼 점",
  "system": "시스템 프롬프트",
  "user": "<concepts>\n{{CONCEPTS}}\n</concepts>\n\n<question>\n{{QUESTION}}\n</question>",
  "conceptNotes": "concept-notes.json"
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `name`, `system`, `user` | 예 | 결과표 이름, 시스템 프롬프트, 사용자 메시지입니다 |
| `description` | 아니요 | 결과 `.md`에 들어가는 설명입니다 |
| `conceptNotes` | 아니요 | 개념별 한 줄 정리 JSON 파일 경로입니다. 프롬프트 파일 위치를 기준으로 씁니다 |
| `schema` | 아니요 | 응답 JSON 스키마입니다. 기본값은 `conceptIds`, `keywords` 문자열 배열이고, `conceptId` 하나로 받게 바꿀 수도 있습니다 |

`{{CONCEPTS}}`는 `개념ID: 개념 이름` 줄 목록(`conceptNotes`가 있으면 `개념ID: 개념 이름 - 한 줄 정리`)으로, `{{QUESTION}}`은 질문으로 바뀝니다.

## 질문 세트 형식

```json
[{ "question": "LAG랑 LEAD는 뭐가 달라요?", "expected": ["s2-12-3"], "note": "P1 용어 직접" }]
```

`expected`가 정답 개념 ID 배열이고, 해당 개념이 없으면 빈 배열을 씁니다. `note`는 결과표의 "메모" 칸에 나옵니다.

## 주의할 점

- `harness.ts`는 서비스의 `lib/llm/ask-json.ts`를 거치지 않고 SDK를 직접 호출합니다. 모델, effort, 최대 토큰은 `ask-json.ts`와 같게 맞춰 두었으므로, 서비스에서 이 설정을 바꾸면 `harness.ts`도 고치세요.
- `prompts/baseline.json`은 서비스 프롬프트를 복사한 파일입니다. 서비스 프롬프트가 바뀌면 이 파일도 고쳐야 baseline이 실제 서비스와 같아집니다.
- `count-tokens.ts`는 서비스 흐름(분류, 답변, 요약)의 입력 토큰을 잽니다. 서비스 저장소에서 `node --conditions=react-server --env-file=.env.local --env-file=.env.test.local --import tsx ../silo-4th-ai-evals/classify/count-tokens.ts`로 실행합니다.
