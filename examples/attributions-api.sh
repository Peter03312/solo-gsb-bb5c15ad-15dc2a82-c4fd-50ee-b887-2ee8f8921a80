#!/usr/bin/env bash
# 说话人归属与署名版导出完整调用示例（审校在现有字幕上标明发言者，导出带 <v> 标签的 WebVTT）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/attributions-api.sh [BASE_URL]
# 例如：bash examples/attributions-api.sh http://localhost:3000
#
# 流程：新建项目并排版 → 维护说话人（编号+显示名，改名推进归属版本）→ 归属提交
#       （按字幕 ID 携带行版本与归属版本；锁定行也可标注）→ 各类失败示例
#       （非法显示名/未知编号/版本过期/缺归属/译文逐行问题）→ 署名版导出
#       （原文与译文共用时间轴的 <v> 标签 WebVTT 不可变快照）→ 重排后归属命运。
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin)
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（准备源字幕） ==="
WORDS='{"name":"说话人归属示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID（初始归属版本 attr_version=$(echo "$out" | body_of | jget attr_version)）"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "源字幕 id=$SID1 / $SID2（字幕集版本 sub_version=$SUBV）"

echo
echo "=== 1. 维护说话人：编号 + 显示名（每次新增/改名推进归属版本） ==="
req POST "/api/projects/$PID/speakers" '{"code":"S1","name":"张三"}' >/dev/null
out="$(req POST "/api/projects/$PID/speakers" '{"code":"S2","name":"李四"}')"
ATTRV="$(echo "$out" | body_of | jget attr_version)"
echo "已创建 S1=张三 / S2=李四，归属版本 attr_version=$ATTRV"
echo "--- 非法显示名（含标签界定符）→ 400 ---"
req POST "/api/projects/$PID/speakers" '{"code":"S3","name":"王<v>五"}' | body_of \
  | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["errors"][0])'
echo "--- 显示名含换行 → 400 ---"
req POST "/api/projects/$PID/speakers" '{"code":"S3","name":"王\n五"}' | body_of \
  | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["errors"][0])'
echo "--- 改名（显示名修改推进归属版本） ---"
out="$(req PATCH "/api/projects/$PID/speakers/S2" '{"name":"李四（配音）","attr_version":'"$ATTRV"'}')"
ATTRV="$(echo "$out" | body_of | jget attr_version)"
echo "S2 改名后 attr_version=$ATTRV"

echo
echo "=== 2. 归属提交：按字幕 ID 携带读取时行版本与归属版本 ==="
echo "--- 未知说话人编号 → 400（编号须存在） ---"
req POST "/api/projects/$PID/attributions" \
  '{"attr_version":'"$ATTRV"',"items":[{"subtitle_id":'"$SID1"',"cue_version":1,"speaker":"GHOST"}]}' \
  | body_of | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["errors"][0])'
echo "--- 归属版本过期 → 409 返回当前值 ---"
req POST "/api/projects/$PID/attributions" \
  '{"attr_version":99,"items":[{"subtitle_id":'"$SID1"',"cue_version":1,"speaker":"S1"}]}' \
  | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print(" ", d["error"]); print("  当前归属版本:", d["current"]["attr_version"])'
echo "--- 锁定第一行后照样可标注（锁定行也可标注） ---"
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"locked":true}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
CUE1V="$(echo "$out" | body_of | jget subtitle.version)"
echo "字幕 $SID1 已锁定（行版本 v$CUE1V）"
out="$(req POST "/api/projects/$PID/attributions" \
  '{"attr_version":'"$ATTRV"',"items":[
    {"subtitle_id":'"$SID1"',"cue_version":'"$CUE1V"',"speaker":"S1"},
    {"subtitle_id":'"$SID2"',"cue_version":1,"speaker":"S2"}]}')"
echo "归属提交 HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  attr_version =", d["attr_version"], " counts =", d["counts"])
for a in d["applied"]: print("  ", a["subtitle_id"], "->", a["speaker"], a["name"], "("+a["action"]+")")'
ATTRV="$(echo "$out" | body_of | jget attr_version)"

echo
echo "=== 3. 归属视图：逐行 字幕 + 说话人 + 状态 ==="
req GET "/api/projects/$PID/attributions" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  attr_version =", d["attr_version"], " counts =", d["counts"])
for e in d["entries"]:
    a = e["attribution"]
    who = ("%s(%s)" % (a["speaker_name"], a["speaker"])) if a else "（待标注）"
    lock = "🔒" if e["cue"]["locked"] else "  "
    print("  %s #%s %-10s %s" % (lock, e["cue"]["id"], e["cue"]["text"], who))'

echo
echo "=== 4. 署名版导出（原文）：携带字幕集版本与归属版本 ==="
echo "--- 归属版本漂移 → 409 ---"
req POST "/api/projects/$PID/attributed-exports" \
  '{"sub_version":'"$SUBV"',"attr_version":1}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ", d["error"])'
echo "--- 成功导出（原文 + 说话人标签） ---"
out="$(req POST "/api/projects/$PID/attributed-exports" \
  '{"sub_version":'"$SUBV"',"attr_version":'"$ATTRV"'}')"
echo "HTTP $(echo "$out" | code_of)：署名版 v$(echo "$out" | body_of | jget version)"
echo "$out" | body_of | jget content

echo
echo "=== 5. 署名版导出（一种目标语言）：携带逐行译文版本，与原文共用时间轴 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":'"$CUE1V"'}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
echo "英语译文已保存（两行均 v1）"
echo "--- 译文版本漂移（提交 v9）→ 422 按行列原因，不生成快照 ---"
req POST "/api/projects/$PID/attributed-exports" \
  '{"sub_version":'"$SUBV"',"attr_version":'"$ATTRV"',"lang":"en",
    "translations":[{"subtitle_id":'"$SID1"',"version":9},{"subtitle_id":'"$SID2"',"version":1}]}' \
  | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
vs = d["translation"]["version_stale"][0]
print("  字幕", vs["subtitle_id"], ":", vs["reasons"][0])'
echo "--- 成功导出（译文 + 说话人标签） ---"
out="$(req POST "/api/projects/$PID/attributed-exports" \
  '{"sub_version":'"$SUBV"',"attr_version":'"$ATTRV"',"lang":"en",
    "translations":[{"subtitle_id":'"$SID1"',"version":1},{"subtitle_id":'"$SID2"',"version":1}]}')"
echo "HTTP $(echo "$out" | code_of)：署名版 v$(echo "$out" | body_of | jget version)（lang=en）"
echo "$out" | body_of | jget content

echo
echo "=== 6. 快照清单与下载（不可变，可查询） ==="
req GET "/api/projects/$PID/attributed-exports" | body_of | python3 -c 'import json,sys
for r in json.load(sys.stdin):
    print("  v%s lang=%s cues=%s sub_v%s attr_v%s -> %s" % (
      r["version"], r["lang"] or "(原文)", r["cue_count"],
      r["sub_version"], r["attr_version"], r["download_url"]))'
echo "下载原文署名版 v1："
curl -s "$BASE/api/projects/$PID/attributed-exports/1"

echo
echo "=== 7. 重排联动：保留 ID 的归属继续有效；删除行归属留作历史，新行待标注 ==="
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":'"$SUBV"'}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
echo "同规则重排后 IDs 不变：$(echo "$out" | body_of | python3 -c 'import json,sys
print([c["id"] for c in json.load(sys.stdin)["subtitles"]])') → 归属继续有效"
req GET "/api/projects/$PID/attributions" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  counts =", d["counts"], " history =", len(d["history"]))'
echo "--- 重新导入（force）清空字幕：归属全部留作历史，不按展示序号转移 ---"
IMPORT_BODY='{"words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200],"force":true}'
req POST "/api/projects/$PID/import" "$IMPORT_BODY" >/dev/null
req GET "/api/projects/$PID/attributions" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  counts =", d["counts"], " history =", len(d["history"]), " attr_version =", d["attr_version"])'

echo
echo "完成。普通导出及旧下载内容保持兼容（不含说话人标签）："
echo "  POST $BASE/api/projects/$PID/exports"
echo "  GET  $BASE/api/projects/$PID/exports/1"
