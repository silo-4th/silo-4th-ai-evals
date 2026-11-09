# 실행 도중 맥이 잠자기에 들어가 생긴 시간 초과 행을, 같은 입력으로 다시 돌린 행으로 바꿔 넣는다. API를 부르지 않는다.
# 사용법: python3 merge-rerun.py <원래 결과.json> <다시 돌린 결과.json> <회차> <출력.json>
# 바꾼 원래 행은 지우지 않고 excludedRows에 이유와 함께 남긴다. 다시 돌린 행에는 rerun 표시를 붙인다.
import json
import sys

orig_path, rerun_path, run, out_path = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
REASON = "맥 잠자기 때문에 CLI가 180초 안에 끝나지 않았다(프롬프트와 무관). 같은 입력을 다시 돌린 행으로 바꿨다."
REASON_DROP = "맥 잠자기 때문에 CLI가 180초 안에 끝나지 않았다(프롬프트와 무관). 빈칸 문제가 아니라서 다시 돌리지 않고 통계에서 뺐다."

orig = json.load(open(orig_path))
rerun = json.load(open(rerun_path))
new_rows = {r["caseId"]: r for res in rerun["results"] for r in res["rows"]}

excluded = []
for res in orig["results"]:
    kept = []
    for r in res["rows"]:
        timed_out = r["run"] == run and r.get("error") and "180초" in r["error"]
        if timed_out:
            excluded.append({**r, "excludedReason": REASON})
            nr = new_rows.get(r["caseId"])
            if nr is None:
                # 다시 돌리지 않은 행(구독제 CLI 조건에서 비교 불가인 객관식, 서술형)은 통계에서 빼기만 한다.
                excluded[-1]["excludedReason"] = REASON_DROP
            else:
                kept.append({**nr, "run": run, "rerun": True})
        else:
            kept.append(r)
    res["rows"] = kept

orig["excludedRows"] = excluded
orig["rerunFrom"] = rerun_path
orig["spend"] = orig.get("spend", 0) + rerun.get("spend", 0)
json.dump(orig, open(out_path, "w"), ensure_ascii=False, indent=2)
print(f"제외한 행 {len(excluded)}개: {', '.join(r['caseId'] + ('(다시 돌림)' if r['excludedReason'] == REASON else '(뺌)') for r in excluded)}")
