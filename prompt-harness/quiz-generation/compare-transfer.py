# 구독제 CLI 조건의 결과를 보정(records 2.3절)에서 API 조건과 일치한 지표만으로 비교한다. API를 부르지 않는다.
# 사용법: python3 compare-transfer.py [--only d01,d02] [--runs 1,2] <결과.json>:<버전> [<결과.json>:<버전> ...]
#   --only와 --runs를 주면 모든 버전을 같은 입력과 회차로 좁혀 비교한다(빠른 세트 비교용).
# 비율은 "회차 평균 (최소 회차)"이고, 회차 사이 편차를 보려고 최대 회차도 함께 적는다.
import json
import sys

KEYS = ["scope", "answer_correct", "self_contained", "hint_no_leak", "explanation_correct", "sqld_fit"]
LIMIT = "usage limits"


args = sys.argv[1:]
ONLY = None
RUNS = None
while args and args[0].startswith("--"):
    flag, val = args[0], args[1]
    args = args[2:]
    if flag == "--only":
        ONLY = set(val.split(","))
    elif flag == "--runs":
        RUNS = {int(x) for x in val.split(",")}


def load(spec):
    path, version = spec.rsplit(":", 1)
    d = json.load(open(path))
    rows = [r for res in d["results"] if res["prompt"]["name"] == version for r in res["rows"]]
    # 한도 오류 행은 빼고, CLI 구조화 출력 실패도 서비스에 없는 실패라 따로 센다.
    rows = [r for r in rows if not (r.get("error") and LIMIT in r["error"])]
    if ONLY:
        rows = [r for r in rows if r["caseId"] in ONLY]
    if RUNS:
        rows = [r for r in rows if r["run"] in RUNS]
    return version, rows


def rate(rows, pred, base=lambda r: True):
    runs = sorted({r["run"] for r in rows})
    vals = []
    for k in runs:
        g = [r for r in rows if r["run"] == k and base(r)]
        if g:
            vals.append(100 * sum(1 for r in g if pred(r)) / len(g))
    if not vals:
        return "-"
    return f"{sum(vals) / len(vals):.1f} ({min(vals):.1f}~{max(vals):.1f})"


def jp(k):
    return lambda r: bool(r.get("judge")) and r["judge"][k]["pass"]


def auto_ok(r):
    a = r.get("auto")
    return bool(a) and a["parsed"] and a["formatRule"] and not a["banned"] and a["tableOk"]


blank = lambda r: r["format"] == "blank"
judged = lambda r: bool(r.get("judge")) or bool(r.get("error"))

METRICS = [
    ("[이전 가능] 빈칸 모양 검사·형식 규칙", lambda r: bool(r.get("auto")) and r["auto"]["parsed"] and r["auto"]["formatRule"], blank),
    ("[이전 가능] 빈칸 금지 표현 없음", lambda r: bool(r.get("auto")) and not r["auto"]["banned"], blank),
    ("[이전 가능] 빈칸 SQLD 적합", jp("sqld_fit"), lambda r: blank(r) and judged(r)),
    ("[이전 가능] 빈칸 힌트 안전", jp("hint_no_leak"), lambda r: blank(r) and judged(r)),
    ("[이전 가능] 빈칸 정답 하나·맞음", jp("answer_correct"), lambda r: blank(r) and judged(r)),
    ("[이전 가능] 빈칸 해설 맞음", jp("explanation_correct"), lambda r: blank(r) and judged(r)),
    ("[이전 가능] 빈칸 전 항목 통과", lambda r: auto_ok(r) and all(jp(k)(r) for k in KEYS), lambda r: blank(r) and judged(r)),
    ("[이전 가능] 힌트 안전(전체)", jp("hint_no_leak"), judged),
    ("[이전 가능] 출제 범위(전체)", jp("scope"), judged),
    ("[이전 가능] 금지 표현 없음(전체)", lambda r: bool(r.get("auto")) and not r["auto"]["banned"], lambda r: True),
    ("[비교 불가] 객관식 정답 하나·맞음", jp("answer_correct"), lambda r: r["format"] == "mcq" and judged(r)),
    ("[비교 불가] 객관식 해설 맞음", jp("explanation_correct"), lambda r: r["format"] == "mcq" and judged(r)),
    ("[비교 불가] 서술형 정답 하나·맞음", jp("answer_correct"), lambda r: r["format"] == "free" and judged(r)),
    ("[비교 불가] 서술형 해설 맞음", jp("explanation_correct"), lambda r: r["format"] == "free" and judged(r)),
    ("[참고] 전 항목 통과(전체)", lambda r: auto_ok(r) and all(jp(k)(r) for k in KEYS), judged),
]

versions = [load(s) for s in args]
print("| 지표 | " + " | ".join(v for v, _ in versions) + " |")
print("|---|" + "---|" * len(versions))
for name, pred, base in METRICS:
    print(f"| {name} | " + " | ".join(rate(rows, pred, base) for _, rows in versions) + " |")
print("| 집계 행(빈칸) | " + " | ".join(f"{len(rows)}({sum(1 for r in rows if blank(r))})" for _, rows in versions) + " |")
print("| CLI 구조화 출력 실패 | " + " | ".join(str(sum(1 for r in rows if r.get("error") and "structured_output" in r["error"])) for _, rows in versions) + " |")
