#!/bin/sh
# 사용법: sh run.sh [프롬프트 파일 ...] [--runs 3] [--only d01,d02] [--limit N] [--concurrency 4] [--no-judge] [--tag 이름]
# 예시:   sh run.sh prompts/baseline.json prompts/baseline-sqld.json --runs 3
# 파일 경로는 이 명령을 실행한 위치 기준이다. 공통 실행 스크립트(../shared/run.sh)가 저장소로 옮겨 실행하고 develop 커밋을 기록한다.
HERE=$(cd "$(dirname "$0")" && pwd)
exec sh "$HERE/../shared/run.sh" "$HERE/harness.ts" "$@"
