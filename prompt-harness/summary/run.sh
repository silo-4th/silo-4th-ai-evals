#!/bin/sh
# 사용법(summary/ 폴더에서): sh run.sh [프롬프트 파일 ...] [--runs 3] [--limit N] [--no-judge] [--followup N]
# 예시:   sh run.sh prompts/baseline.json prompts/v1-purpose.json --followup 12
# 공통 실행기(shared/run.sh)를 부른다. 파일 경로는 이 명령을 실행한 위치 기준이다.
HERE=$(cd "$(dirname "$0")" && pwd)
exec sh "$HERE/../shared/run.sh" "$HERE/harness.ts" "$@"
