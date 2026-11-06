#!/bin/sh
# 사용법: sh run.sh [프롬프트 파일 ...] [--questions 질문 파일]
# 예시:   sh run.sh prompts/baseline.json prompts/v2.json
# 파일 경로는 이 명령을 실행한 위치 기준이다. 아무것도 넘기지 않으면 prompts/baseline.json과 questions.json을 쓴다.
# API 키는 저장소의 .env.local에서, DB 주소는 .env.test.local의 test 브랜치에서 읽는다. 뒤에 적은 파일이 앞 파일을 덮는다.
HERE=$(cd "$(dirname "$0")" && pwd)
# 서비스 저장소 위치. 이 저장소와 silo-4th를 같은 폴더에 두면 따로 지정하지 않아도 된다.
REPO=${SILO_4TH_REPO:-$(cd "$HERE/../.." && pwd)/silo-4th}

# 저장소로 이동하기 전에 넘겨받은 상대 경로를 절대 경로로 바꾼다.
ARGS=""
for a in "$@"; do
  case "$a" in
    --*) ARGS="$ARGS $a" ;;
    /*) ARGS="$ARGS $a" ;;
    *) ARGS="$ARGS $(pwd)/$a" ;;
  esac
done

cd "$REPO" || exit 1
# shellcheck disable=SC2086
exec node --conditions=react-server --env-file=.env.local --env-file=.env.test.local \
  --import tsx "$HERE/harness.ts" $ARGS
