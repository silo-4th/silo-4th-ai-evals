# silo-4th AI 평가 기록

silo-4th 서비스의 AI 기능을 바꾸기 전에 여러 버전을 시험한 결과를 모아 둔 저장소입니다. 프롬프트를 고칠 때 어떤 버전이 가장 나았는지, 그 근거가 무엇인지 여기서 확인할 수 있습니다.

프롬프트는 서비스 저장소 [silo-4th](https://github.com/silo-4th/silo-4th)에서 고칩니다. 이 저장소에는 시험 결과와 반영 제안만 있습니다.

## 평가 목록

| 평가 | 서비스 코드 | 최근 측정 | 결론 | 상태 |
| --- | --- | --- | --- | --- |
| [질문 개념 분류](classify/) | `lib/llm/tagging.ts`의 `classifyQuestion` | [2026-11-06](classify/records/2026-11-06-single-concept.md) | `single-notes` 채택. 일치 76 → 101 / 106 | develop cb5cd23에 반영됨 |
| [답변](prompt-harness/answer/) | `lib/llm/answer.ts`의 `streamAnswer` | [2026-11-08](prompt-harness/records/2026-11-08-answer.md) | `v3-grounded` 추천. 전 항목 통과 70.6% → 98.5%, 길이 770 → 336자 | 4-102 반영 가능, 4-65 원칙 문장과 합칠 것 |
| [질문 요약](prompt-harness/summary/) | `lib/llm/tagging.ts`의 `summarizeQuestion` | [2026-11-08](prompt-harness/records/2026-11-08-summary.md) | `r2b-nofab-kw0-folded` 추천. 모두 통과 77.2% → 94.9%(구독 CLI) | 추천 확정 |
| [서술형 채점](prompt-harness/grading/) | `lib/llm/grading.ts`의 `gradeFreeAnswer` | [2026-11-08](prompt-harness/records/2026-11-08-grading.md) | `checklist` 후보. 라벨 일치 93 → 96 / 96(구독 CLI) | 기준 A/B, keyPoints 존폐, 라벨 검수 대기 |
| [퀴즈 생성](prompt-harness/quiz-generation/) | `lib/llm/quiz-generation.ts`의 `generateQuizProblem` | [2026-11-08](prompt-harness/records/2026-11-08-quiz-generation.md) | "SQLD" 수정 즉시, `v4-blank` 추천. 빈칸 통과 30% → 95%(구독 CLI). 퓨샷은 보류 | API 조건 확인 대기 |

답변, 요약, 채점, 퀴즈 생성 평가는 `prompt-harness/`에 공통 도구(`shared/`)와 함께 있습니다. 전체 흐름과 기능별 추천 프롬프트는 [AI 프롬프트 개선안](prompt-harness/records/2026-11-09-ai-prompt-guide.html)(HTML)과 [전체 정리](prompt-harness/records/2026-11-08-overview.md)에서 먼저 보세요. 참고 데이터를 서비스 코드와 Linear에 대조한 결과는 [설계 확인](prompt-harness/records/2026-11-09-data-flow-audit.md)에 있습니다.

②~④의 수치 대부분은 API 사용 한도(12/1 해제) 때문에 구독 계정(Claude Code CLI)으로 잰 값입니다. 버전 사이의 차이만 근거로 쓰고, 서비스 반영 전에 API 조건으로 한 번 확인합니다.

## 측정 기록에서 확인할 것

측정 기록 문서는 모두 같은 순서로 씁니다. 바쁘면 "요약"과 "서비스 반영 제안"만 읽으세요.

1. **요약**: 추천 버전과 핵심 숫자
2. **배경**: 이 측정을 한 이유
3. **측정 조건**: 모델, 질문 세트, 실행 횟수
4. **시험한 버전**: 버전마다 바꾼 점
5. **결과**: 버전별 비교표
6. **결과 해석**: 숫자 차이가 생긴 이유
7. **서비스 반영 제안**: 서비스 코드에서 바꿀 내용
8. **완료 기준**: 반영한 뒤 확인할 숫자
9. **남은 작업**: 정답 검수처럼 아직 끝나지 않은 일

## 결과를 믿을 수 있는지 판단하기

- **정답 검수**: 측정 기록 맨 위에 정답 검수 상태가 있습니다. "미완료"라면 정답이 확정되지 않은 문항이 있다는 뜻이므로, 해당 문항 목록을 함께 보세요.
- **실행 횟수**: AI는 같은 질문에도 실행마다 다르게 답할 수 있습니다. 결과표의 "1차 / 2차" 숫자가 크게 다르면 그 버전은 불안정한 것입니다.
- **원본 결과**: 질문별 결과는 각 평가 폴더의 `results/`에 있습니다. 파일 이름은 실행 시각(UTC)입니다.
