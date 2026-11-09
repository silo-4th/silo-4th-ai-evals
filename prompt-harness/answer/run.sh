#!/bin/sh
# 사용법: sh run.sh [프롬프트 파일 ...] [--runs 3] [--kinds single,oos] [--limit N] [--no-judge] [--cases 파일]
# 예시:   sh run.sh prompts/baseline.json prompts/v1-concise.json --runs 3
# 결과 비교표만 다시 만들 때: sh run.sh --report results/a.json results/b.json
# 이 폴더에서 실행한다. 실행 환경(.env 파일, 커밋 해시)은 ../shared/run.sh가 맞춘다.
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE" || exit 1
exec sh ../shared/run.sh harness.ts "$@"
