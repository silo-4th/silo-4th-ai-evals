#!/bin/sh
# 사용법: sh grading/run.sh [프롬프트 파일 ...] [--runs 3] [--concurrency 4] [--limit N] [--labels 라벨 파일]
# 예시:   sh grading/run.sh grading/prompts/baseline.json grading/prompts/crit-b.json
# 프롬프트를 주지 않으면 grading/prompts/*.json 전부를 3회씩 돌린다. 공통 실행기 shared/run.sh를 부른다.
HERE=$(cd "$(dirname "$0")" && pwd)
exec sh "$HERE/../shared/run.sh" "$HERE/harness.ts" "$@"
