#!/bin/sh
# 사용법: sh shared/run.sh <하네스.ts> [인자 ...]
# 예시:   sh shared/run.sh summary/harness.ts summary/prompts/baseline.json --runs 3
# 트랙 폴더의 run.sh는 이 파일을 부른다. 파일 경로는 이 명령을 실행한 위치 기준이다.
# API 키는 저장소의 .env.local에서, DB 주소는 .env.test.local의 test 브랜치에서 읽는다. 뒤에 적은 파일이 앞 파일을 덮는다.
REPO=/Users/banjax.index/orca/silo-4th

# 저장소로 이동하기 전에 넘겨받은 상대 경로를 절대 경로로 바꾼다. --로 시작하는 옵션과 숫자, 실제로 없는 경로는 그대로 둔다.
ARGS=""
for a in "$@"; do
  case "$a" in
    --*|/*) ARGS="$ARGS $a" ;;
    *) if [ -e "$a" ]; then ARGS="$ARGS $(pwd)/$a"; else ARGS="$ARGS $a"; fi ;;
  esac
done

cd "$REPO" || exit 1
# 결과 파일에 적을 develop 커밋이다. 서비스 코드와 같은 조건인지 나중에 확인하려고 남긴다.
HARNESS_COMMIT=$(git rev-parse --short HEAD)
HARNESS_ORIGIN=$(git rev-parse --short origin/develop 2>/dev/null)
export HARNESS_COMMIT HARNESS_ORIGIN
if [ "$HARNESS_COMMIT" != "$HARNESS_ORIGIN" ]; then
  echo "주의: 로컬 HEAD($HARNESS_COMMIT)가 origin/develop($HARNESS_ORIGIN)과 다르다. git fetch 후 develop을 맞춘다." >&2
fi
# shellcheck disable=SC2086
exec node --conditions=react-server --env-file=.env.local --env-file=.env.test.local --import tsx $ARGS
