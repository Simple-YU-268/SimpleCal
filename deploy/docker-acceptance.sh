#!/usr/bin/env bash
# SimpleCal Docker 主机验收脚本。
#
# 把 DOCKER.md「Docker 主机验收」那六条人工检查变成可重复执行的断言，
# 顺带验证 0.4.0 的深靛蓝主题确实上线。
#
# 在部署目录（docker-compose.yml 所在处）执行：
#   bash deploy/docker-acceptance.sh
#
# 可覆盖的环境变量：
#   BASE_URL     默认 http://127.0.0.1:5581
#   CONTAINER    默认 simplecal
#   DAV_USER     默认 caldav
#   COMPOSE      默认 "docker compose"
#   EXPECTED_VERSION  默认 0.4.1
#   SKIP_RESTART 设为 1 时跳过重启与 SIGTERM 两组检查
#   ADMIN_PASSWORD 已改过密码的实例用它提供当前密码；
#                   新装实例留空，脚本读容器内的初始密码文件
#
# 退出码：0 全部通过；1 有失败项。

set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:5581}"
CONTAINER="${CONTAINER:-simplecal}"
DAV_USER="${DAV_USER:-caldav}"
SKIP_RESTART="${SKIP_RESTART:-0}"
EXPECTED_VERSION="${EXPECTED_VERSION:-0.4.1}"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 注意：COMPOSE_BIN 是多词命令（"docker compose"），必须允许分词。
# 写成 "$COMPOSE_BIN" 会去找一个叫 "docker compose" 的单个可执行文件。
COMPOSE_BIN="${COMPOSE_BIN:-docker compose}"
compose() { $COMPOSE_BIN "$@"; }

pass() { PASS=$((PASS + 1)); printf '[PASS] %s | %s\n' "$1" "$2"; }
fail() { FAIL=$((FAIL + 1)); printf '[FAIL] %s | %s\n' "$1" "$2"; }
note() { printf '       %s\n' "$1"; }
head2() { printf '\n=== %s ===\n' "$1"; }

# 取 JSON 里的一个字段；没有 python3 就退化到 grep。
jget() {
  local json="$1" path="$2"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json,sys
doc=json.loads(sys.stdin.read() or "{}")
for key in sys.argv[1].split("."):
    if isinstance(doc,list):
        doc=doc[int(key)]
    else:
        doc=doc.get(key) if isinstance(doc,dict) else None
    if doc is None: break
print("" if doc is None else (doc if isinstance(doc,str) else json.dumps(doc)))' "$path" <<<"$json"
  else
    grep -o "\"$path\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" <<<"$json" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'
  fi
}

http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

wait_healthy() {
  local i=0 state
  while [ "$i" -lt 60 ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null)"
    [ "$state" = "healthy" ] && return 0
    i=$((i + 1))
    sleep 2
  done
  return 1
}

########################################################################
head2 "1. 容器与健康检查"
########################################################################

state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)"
if [ "$state" = "running" ]; then
  pass "容器运行中" "$CONTAINER = running"
else
  fail "容器运行中" "$CONTAINER = ${state:-<不存在>}"
fi

if wait_healthy; then
  pass "健康检查通过" "health = healthy"
else
  fail "健康检查通过" "health = $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)"
  note "--- 容器日志尾部 ---"
  docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/       /'
fi

########################################################################
head2 "2. 版本、静态资源与主题色"
########################################################################

version_body="$(curl -sS --max-time 20 "$BASE_URL/api/version" 2>/dev/null)"
version="$(jget "$version_body" version)"
if [ "$version" = "$EXPECTED_VERSION" ]; then
  pass "/api/version 返回 $EXPECTED_VERSION" "version = $version"
else
  fail "/api/version 返回 $EXPECTED_VERSION" "version = ${version:-<空>} (body: ${version_body:0:160})"
fi

index_code="$(http_code "$BASE_URL/")"
if [ "$index_code" = "200" ] && curl -sS --max-time 20 "$BASE_URL/" | grep -q "SimpleCal"; then
  pass "登录页可加载" "GET / -> 200 且含 SimpleCal"
else
  fail "登录页可加载" "GET / -> $index_code"
fi

icon_code="$(http_code "$BASE_URL/icon-192.png")"
if [ "$icon_code" = "200" ]; then
  pass "PWA 图标可加载" "GET /icon-192.png -> 200"
else
  fail "PWA 图标可加载" "GET /icon-192.png -> $icon_code"
fi

prepaint="$(curl -sS --max-time 20 "$BASE_URL/accent-prepaint.js" 2>/dev/null)"
if printf '%s' "$prepaint" | grep -qi "3b54c4"; then
  pass "首屏主题色为深靛蓝" "accent-prepaint.js 含 3b54c4"
else
  fail "首屏主题色为深靛蓝" "accent-prepaint.js 未见 3b54c4"
fi

manifest="$(curl -sS --max-time 20 "$BASE_URL/site.webmanifest" 2>/dev/null)"
theme="$(jget "$manifest" theme_color)"
if [ "$(printf '%s' "$theme" | tr 'A-Z' 'a-z')" = "#3b54c4" ]; then
  pass "PWA theme_color 为深靛蓝" "theme_color = $theme"
else
  fail "PWA theme_color 为深靛蓝" "theme_color = ${theme:-<空>}"
fi

########################################################################
head2 "3. 认证：随机密码登录 + 首登强制改密"
########################################################################

INITIAL_PASSWORD="$(docker exec "$CONTAINER" sh -c 'cat /data/admin-initial-password.txt 2>/dev/null' | tr -d '\r\n')"
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  INITIAL_PASSWORD="$ADMIN_PASSWORD"
  note "使用 ADMIN_PASSWORD 环境变量提供的密码"
elif [ -n "$INITIAL_PASSWORD" ]; then
  pass "容器内生成初始密码文件" "/data/admin-initial-password.txt 已写入"
else
  fail "容器内生成初始密码文件" "读不到 /data/admin-initial-password.txt，且未提供 ADMIN_PASSWORD"
fi

login() {
  curl -sS -c "$WORK/jar" -o "$WORK/login.json" -w '%{http_code}' --max-time 20 \
    -X POST -H 'Content-Type: application/json' \
    -d "{\"username\":\"$DAV_USER\",\"password\":\"$1\"}" \
    "$BASE_URL/api/v1/auth/login"
}

bad_code="$(login "definitely-not-the-password")"
if [ "$bad_code" = "401" ]; then
  pass "错误密码被拒绝" "POST /api/v1/auth/login -> 401"
else
  fail "错误密码被拒绝" "POST /api/v1/auth/login -> $bad_code"
fi

good_code="$(login "$INITIAL_PASSWORD")"
MUST_CHANGE="$(jget "$(cat "$WORK/login.json")" mustChangePassword)"
CSRF="$(jget "$(cat "$WORK/login.json")" csrf)"
if [ "$good_code" = "200" ] && [ "$MUST_CHANGE" = "true" ]; then
  pass "随机密码可登录且要求改密" "200 + mustChangePassword=true"
else
  fail "随机密码可登录且要求改密" "code=$good_code mustChangePassword=${MUST_CHANGE:-<空>}"
fi

NEW_PASSWORD="Acc-$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)!"
change_code="$(curl -sS -b "$WORK/jar" -c "$WORK/jar" -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d "{\"oldPassword\":\"$INITIAL_PASSWORD\",\"newPassword\":\"$NEW_PASSWORD\"}" \
  "$BASE_URL/api/v1/auth/password")"
if [ "$change_code" = "200" ]; then
  pass "修改密码成功" "POST /api/v1/auth/password -> 200"
else
  fail "修改密码成功" "POST /api/v1/auth/password -> $change_code"
fi

  # 初始密码文件只保存那份已经失效的初始密码，改密成功后必须由服务端删掉。
  if docker exec "$CONTAINER" sh -c 'test -e /data/admin-initial-password.txt' >/dev/null 2>&1; then
    fail "改密后初始密码文件已删除" "/data/admin-initial-password.txt 仍存在"
  else
    pass "改密后初始密码文件已删除" "/data/admin-initial-password.txt 不存在"
  fi

old_code="$(login "$INITIAL_PASSWORD")"
if [ "$old_code" = "401" ]; then
  pass "旧密码立即失效" "旧密码登录 -> 401"
else
  fail "旧密码立即失效" "旧密码登录 -> $old_code"
fi

new_code="$(login "$NEW_PASSWORD")"
MUST_CHANGE2="$(jget "$(cat "$WORK/login.json")" mustChangePassword)"
CSRF="$(jget "$(cat "$WORK/login.json")" csrf)"
if [ "$new_code" = "200" ] && [ "$MUST_CHANGE2" != "true" ]; then
  pass "新密码可登录且不再要求改密" "200 + mustChangePassword=${MUST_CHANGE2:-false}"
else
  fail "新密码可登录且不再要求改密" "code=$new_code mustChangePassword=${MUST_CHANGE2:-<空>}"
fi

########################################################################
head2 "4. 事件写入与回读"
########################################################################

EVENT_KEY="cal:evt:acceptance-$(date +%s)"
EVENT_TITLE="Docker 验收事件 $(date +%H%M%S)"
write_code="$(curl -sS -b "$WORK/jar" -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d "[{\"key\":\"$EVENT_KEY\",\"value\":{\"title\":\"$EVENT_TITLE\",\"start\":$(date +%s)000,\"end\":$(( $(date +%s) + 3600 ))000,\"allDay\":false}}]" \
  "$BASE_URL/api/v1/kv")"
if [ "$write_code" = "200" ] || [ "$write_code" = "201" ]; then
  pass "写入事件" "POST /api/v1/kv -> $write_code"
else
  fail "写入事件" "POST /api/v1/kv -> $write_code"
fi

read_body="$(curl -sS -b "$WORK/jar" --max-time 20 "$BASE_URL/api/v1/kv/$EVENT_KEY" 2>/dev/null)"
if printf '%s' "$read_body" | grep -q "$EVENT_TITLE"; then
  pass "事件回读一致" "GET /api/v1/kv/<key> 含标题"
else
  fail "事件回读一致" "GET /api/v1/kv/<key> -> ${read_body:0:160}"
fi

########################################################################
head2 "5. CalDAV 读写"
########################################################################

DAV_AUTH="$DAV_USER:$NEW_PASSWORD"
ICS_UID="acceptance-dav-$(date +%s)"
cat >"$WORK/event.ics" <<EOF
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//SimpleCal//Docker Acceptance//ZH
BEGIN:VEVENT
UID:$ICS_UID
DTSTAMP:20260101T000000Z
DTSTART:20261225T090000Z
DTEND:20261225T100000Z
SUMMARY:Docker 验收 DAV 事件
END:VEVENT
END:VCALENDAR
EOF

propfind_code="$(http_code -u "$DAV_AUTH" -X PROPFIND -H 'Depth: 1' "$BASE_URL/calendars/$DAV_USER/default/")"
if [ "$propfind_code" = "207" ]; then
  pass "CalDAV PROPFIND 日历集合" "-> 207 Multi-Status"
else
  fail "CalDAV PROPFIND 日历集合" "-> $propfind_code"
fi

put_code="$(http_code -u "$DAV_AUTH" -T "$WORK/event.ics" -X PUT "$BASE_URL/calendars/$DAV_USER/default/$ICS_UID.ics")"
if [ "$put_code" = "201" ] || [ "$put_code" = "204" ]; then
  pass "CalDAV PUT 事件" "-> $put_code"
else
  fail "CalDAV PUT 事件" "-> $put_code"
fi

get_body="$(curl -sS -u "$DAV_AUTH" --max-time 20 "$BASE_URL/calendars/$DAV_USER/default/$ICS_UID.ics" 2>/dev/null)"
if printf '%s' "$get_body" | grep -q "SUMMARY:Docker 验收 DAV 事件"; then
  pass "CalDAV GET 回读事件" "内容一致"
else
  fail "CalDAV GET 回读事件" "${get_body:0:160}"
fi

########################################################################
head2 "6. CardDAV 读写"
########################################################################

book_propfind="$(curl -sS -u "$DAV_AUTH" -X PROPFIND -H 'Depth: 1' --max-time 20 "$BASE_URL/addressbooks/$DAV_USER/" 2>/dev/null)"
book_code="$(http_code -u "$DAV_AUTH" -X PROPFIND -H 'Depth: 1' "$BASE_URL/addressbooks/$DAV_USER/")"
BOOK_ID="$(printf '%s' "$book_propfind" | grep -o "$BASE_URL/addressbooks/$DAV_USER/[A-Za-z0-9_-]*/" | head -1 | sed "s|.*/$DAV_USER/||; s|/$||")"
if [ "$book_code" = "207" ]; then
  pass "CardDAV PROPFIND 地址簿主页" "-> 207"
else
  fail "CardDAV PROPFIND 地址簿主页" "-> $book_code"
fi

# 服务端首次访问时会给用户补一个默认通讯录（contacts）；
# 万一实例上找不到（老数据被删过），就用 MKCOL 建一个。
if [ -z "$BOOK_ID" ]; then
  BOOK_ID="acceptance"
  cat >"$WORK/mkcol.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8" ?>
<D:mkcol xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
  <D:set>
    <D:prop>
      <D:displayname>Docker 验收通讯录</D:displayname>
      <D:resourcetype><D:collection/><A:addressbook/></D:resourcetype>
    </D:prop>
  </D:set>
</D:mkcol>
EOF
  mkcol_code="$(http_code -u "$DAV_AUTH" -X MKCOL -H 'Content-Type: application/xml' \
    --data-binary "@$WORK/mkcol.xml" "$BASE_URL/addressbooks/$DAV_USER/$BOOK_ID/")"
  if [ "$mkcol_code" = "201" ]; then
    pass "CardDAV MKCOL 新建通讯录" "-> 201, book = $BOOK_ID"
  else
    fail "CardDAV MKCOL 新建通讯录" "-> $mkcol_code"
  fi
else
  pass "CardDAV 发现已有通讯录" "book = $BOOK_ID"
fi

VCF_UID="acceptance-contact-$(date +%s)"
cat >"$WORK/contact.vcf" <<EOF
BEGIN:VCARD
VERSION:3.0
UID:$VCF_UID
FN:Docker 验收联系人
N:验收;Docker;;;
EMAIL:acceptance@example.test
END:VCARD
EOF

vcf_put="$(http_code -u "$DAV_AUTH" -T "$WORK/contact.vcf" -X PUT "$BASE_URL/addressbooks/$DAV_USER/$BOOK_ID/$VCF_UID.vcf")"
if [ "$vcf_put" = "201" ] || [ "$vcf_put" = "204" ]; then
  pass "CardDAV PUT 联系人" "-> $vcf_put"
else
  fail "CardDAV PUT 联系人" "-> $vcf_put"
fi

vcf_get="$(curl -sS -u "$DAV_AUTH" --max-time 20 "$BASE_URL/addressbooks/$DAV_USER/$BOOK_ID/$VCF_UID.vcf" 2>/dev/null)"
if printf '%s' "$vcf_get" | grep -q "Docker 验收联系人"; then
  pass "CardDAV GET 回读联系人" "内容一致"
else
  fail "CardDAV GET 回读联系人" "${vcf_get:0:160}"
fi

########################################################################
head2 "7. 容器身份与数据卷"
########################################################################

uid_in="$(docker exec "$CONTAINER" id -u 2>/dev/null | tr -d '\r\n')"
if [ "$uid_in" = "1000" ]; then
  pass "容器以非 root 运行" "uid = 1000"
else
  fail "容器以非 root 运行" "uid = ${uid_in:-<空>}"
fi

if docker exec "$CONTAINER" sh -c 'touch /data/.acceptance-write-probe && rm -f /data/.acceptance-write-probe' >/dev/null 2>&1; then
  pass "数据卷可写" "/data 可写（uid 1000）"
else
  fail "数据卷可写" "/data 不可写"
fi

########################################################################
head2 "8. 重启后数据保留"
########################################################################

if [ "$SKIP_RESTART" = "1" ]; then
  note "SKIP_RESTART=1，跳过重启与 SIGTERM 检查"
else
  started_before="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)"
  compose restart >/dev/null 2>&1
  started_after="$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)"
  if [ -n "$started_after" ] && [ "$started_before" != "$started_after" ]; then
    pass "容器确实重启" "StartedAt $started_before -> $started_after"
  else
    fail "容器确实重启" "StartedAt 未变（$started_before）"
  fi

  if wait_healthy; then
    pass "重启后恢复健康" "health = healthy"
  else
    fail "重启后恢复健康" "health = $(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)"
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/       /'
  fi

  # 会话可能只在内存里，重启后先重新登录再回读。
  relogin_code="$(login "$NEW_PASSWORD")"
  if [ "$relogin_code" = "200" ]; then
    CSRF="$(jget "$(cat "$WORK/login.json")" csrf)"
    pass "重启后可重新登录" "POST /api/v1/auth/login -> 200"
  else
    fail "重启后可重新登录" "POST /api/v1/auth/login -> $relogin_code"
  fi

  after_body="$(curl -sS -b "$WORK/jar" --max-time 20 "$BASE_URL/api/v1/kv/$EVENT_KEY" 2>/dev/null)"
  if printf '%s' "$after_body" | grep -q "$EVENT_TITLE"; then
    pass "重启后事件仍在" "KV 数据保留"
  else
    fail "重启后事件仍在" "KV 数据丢失：${after_body:0:160}"
  fi

  after_dav="$(curl -sS -u "$DAV_AUTH" --max-time 20 "$BASE_URL/calendars/$DAV_USER/default/$ICS_UID.ics" 2>/dev/null)"
  if printf '%s' "$after_dav" | grep -q "SUMMARY:Docker 验收 DAV 事件"; then
    pass "重启后 DAV 事件仍在" "CalDAV 数据保留"
  else
    fail "重启后 DAV 事件仍在" "CalDAV 数据丢失"
  fi

  ######################################################################
  head2 "9. SIGTERM 停止与 PID 文件清理"
  ######################################################################

  docker stop "$CONTAINER" >/dev/null 2>&1
  stop_code=$?
  if [ "$stop_code" = "0" ]; then
    pass "SIGTERM 优雅停止" "docker stop -> 0"
  else
    fail "SIGTERM 优雅停止" "docker stop -> $stop_code"
  fi

  sleep 2
  data_src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null)"
  if [ -n "$data_src" ]; then
    pid_left="$(ls "$data_src/caldav.pid" 2>/dev/null | tr -d '\r\n')"
  else
    pid_left="<找不到 /data 挂载>"
  fi
  if [ -z "$pid_left" ]; then
    pass "PID 文件已清理" "$data_src/caldav.pid 不存在"
  else
    fail "PID 文件已清理" "$data_src/caldav.pid 仍存在"
  fi

  compose up -d >/dev/null 2>&1
  if wait_healthy; then
    pass "重新启动正常" "health = healthy"
  else
    fail "重新启动正常" "health = $(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)"
  fi

  final_code="$(http_code "$BASE_URL/api/version")"
  if [ "$final_code" = "200" ]; then
    pass "重启后 /api/version 正常" "-> 200"
  else
    fail "重启后 /api/version 正常" "-> $final_code"
  fi
fi

########################################################################
printf '\n========================================\n'
printf 'ACCEPTANCE: %d passed, %d failed\n' "$PASS" "$FAIL"
printf '验收密码（新密码）: %s\n' "$NEW_PASSWORD"
printf '========================================\n'

[ "$FAIL" -eq 0 ] || exit 1
