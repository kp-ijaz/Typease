#!/usr/bin/env bash
# TypEase post-deploy smoke test (curl only; jq is used when it is installed).
#
#   scripts/smoke-test.sh --api https://api.example.ae --slug my-centre \
#       --allowed-origin https://app.example.ae --web https://app.example.ae --web https://admin.example.ae
#   SMOKE_EMAIL=ops@example.ae SMOKE_PASSWORD='...' scripts/smoke-test.sh --api https://api.example.ae --app platform
#   scripts/smoke-test.sh --api http://localhost:4000 --direct --slug alnoor-demo --allowed-origin http://localhost:3001
#
# Checks: liveness, readiness (database, system database, redis), public plans, tenant
# configuration for a slug, login + one authenticated call, CORS preflight from an allowed
# and from a disallowed origin, and - through the reverse proxy only - that
# /api/v1/internal/* is NOT reachable from outside, that HTTP redirects to HTTPS and that
# the security headers are present.
#
# --direct   the URL points straight at the API process (no reverse proxy): proxy-only
#            checks are reported as SKIP instead of being run.
#
# The password is read from SMOKE_PASSWORD (preferred: it stays out of the process list)
# or --password. Tokens and passwords are never printed.
# Exit code: 0 = no FAIL, 1 = at least one FAIL, 2 = usage error.
set -uo pipefail

API="${SMOKE_API_URL:-http://localhost:4000}"
SLUG="${SMOKE_TENANT_SLUG:-}"
EMAIL="${SMOKE_EMAIL:-}"
PASSWORD="${SMOKE_PASSWORD:-}"
APP="${SMOKE_APP:-centre}"
ALLOWED_ORIGIN="${SMOKE_ALLOWED_ORIGIN:-}"
DISALLOWED_ORIGIN="${SMOKE_DISALLOWED_ORIGIN:-https://smoke-test-not-allowed.invalid}"
DIRECT=0
TIMEOUT="${SMOKE_TIMEOUT:-15}"
WEB_URLS=()
CURL_EXTRA=()

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --slug) SLUG="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --allowed-origin) ALLOWED_ORIGIN="$2"; shift 2 ;;
    --disallowed-origin) DISALLOWED_ORIGIN="$2"; shift 2 ;;
    --web) WEB_URLS+=("$2"); shift 2 ;;
    --direct) DIRECT=1; shift ;;
    --insecure) CURL_EXTRA+=(--insecure); shift ;;          # self-signed certificate on a staging host
    --resolve) CURL_EXTRA+=(--resolve "$2"); shift 2 ;;      # host:port:address, test before DNS is switched
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
API="${API%/}"
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf 'PASS  %-46s %s\n' "$1" "${2:-}"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %-46s %s\n' "$1" "${2:-}"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %-46s %s\n' "$1" "${2:-}"; }

# http METHOD URL [curl args...]  ->  sets STATUS, body in $TMP/body, headers in $TMP/headers
http() {
  local method="$1" url="$2"; shift 2
  : > "$TMP/body"; : > "$TMP/headers"
  STATUS="$(curl -sS -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' --max-time "$TIMEOUT" \
    ${CURL_EXTRA[@]+"${CURL_EXTRA[@]}"} -X "$method" "$@" "$url" 2>"$TMP/err")" || STATUS="000"
}
header() { grep -i "^$1:" "$TMP/headers" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r'; }
# json FIELD -> value of a top-level string field of $TMP/body (without jq: the first field with that name)
json() {
  if [ "$HAVE_JQ" = 1 ]; then jq -r --arg f "$1" 'if type == "object" then (.[$f] // empty) else empty end' < "$TMP/body" 2>/dev/null
  else grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$TMP/body" | head -n 1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//'; fi
}
curl_error() { head -c 160 "$TMP/err" | tr '\n' ' '; }

echo "TypEase smoke test - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Target: $API$([ "$DIRECT" = 1 ] && echo '  (direct: proxy-only checks are skipped)')"
echo

# --- 1. liveness / readiness -------------------------------------------------
http GET "$API/health"
if [ "$STATUS" = 200 ] && [ "$(json status)" = ok ]; then ok "GET /health" "200 status=ok"
else bad "GET /health" "HTTP $STATUS $(curl_error)"; fi

http GET "$API/health/ready"
if [ "$STATUS" = 200 ] && [ "$(json status)" = ready ]; then ok "GET /health/ready" "200 $(tr -d '\n' < "$TMP/body" | head -c 120)"
else bad "GET /health/ready" "HTTP $STATUS $(tr -d '\n' < "$TMP/body" | head -c 160)"; fi

# --- 2. public endpoints -----------------------------------------------------
http GET "$API/api/v1/public/plans"
if [ "$STATUS" = 200 ] && grep -q '"key"' "$TMP/body"; then
  if [ "$HAVE_JQ" = 1 ]; then ok "GET /api/v1/public/plans" "200, $(jq 'length' < "$TMP/body") plan(s)"; else ok "GET /api/v1/public/plans" "200"; fi
else bad "GET /api/v1/public/plans" "HTTP $STATUS (the platform bootstrap creates the default plans on first API start)"; fi

if [ -n "$SLUG" ]; then
  http GET "$API/api/v1/public/tenant-config?slug=$SLUG"
  if [ "$STATUS" = 200 ] && [ "$(json slug)" = "$SLUG" ]; then ok "GET /api/v1/public/tenant-config?slug=$SLUG" "200 name=\"$(json name)\""
  else bad "GET /api/v1/public/tenant-config?slug=$SLUG" "HTTP $STATUS"; fi
else skip "GET /api/v1/public/tenant-config" "no --slug given"; fi

# --- 3. login + authenticated call ------------------------------------------
if [ -n "$EMAIL" ] && [ -n "$PASSWORD" ]; then
  # The JSON body is written to a file so the password never appears in the process list.
  if [ "$HAVE_JQ" = 1 ]; then
    jq -n --arg e "$EMAIL" --arg p "$PASSWORD" --arg a "$APP" --arg s "$SLUG" \
      '{email: $e, password: $p, app: $a} + (if $s != "" and $a != "platform" then {tenantSlug: $s} else {} end)' > "$TMP/login.json"
  else
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    printf '{"email":"%s","password":"%s","app":"%s"%s}' "$(esc "$EMAIL")" "$(esc "$PASSWORD")" "$APP" \
      "$([ -n "$SLUG" ] && [ "$APP" != platform ] && printf ',"tenantSlug":"%s"' "$SLUG")" > "$TMP/login.json"
  fi
  http POST "$API/api/v1/auth/login" -H 'content-type: application/json' -H "x-client-app: $APP" -H 'x-requested-with: typease-smoke' --data-binary "@$TMP/login.json"
  rm -f "$TMP/login.json"
  LOGIN_STATUS="$(json status)"
  TOKEN="$(json accessToken)"
  case "$STATUS:$LOGIN_STATUS" in
    20[01]:OK)
      ok "POST /api/v1/auth/login" "$STATUS status=OK (access token received, not shown)"
      http GET "$API/api/v1/auth/me" -H "authorization: Bearer $TOKEN" -H "x-client-app: $APP"
      if [ "$STATUS" = 200 ]; then ok "GET /api/v1/auth/me (authenticated)" "200"; else bad "GET /api/v1/auth/me (authenticated)" "HTTP $STATUS"; fi
      http GET "$API/api/v1/auth/me"
      if [ "$STATUS" = 401 ]; then ok "GET /api/v1/auth/me (no token)" "401 as expected"; else bad "GET /api/v1/auth/me (no token)" "HTTP $STATUS, expected 401"; fi
      ;;
    20[01]:MFA_REQUIRED)
      ok "POST /api/v1/auth/login" "$STATUS status=MFA_REQUIRED (password accepted; second factor required)"
      skip "GET /api/v1/auth/me (authenticated)" "the account has two-step verification: use a dedicated smoke-test account without privileged roles"
      ;;
    20[01]:SELECT_TENANT)
      ok "POST /api/v1/auth/login" "$STATUS status=SELECT_TENANT (password accepted)"
      skip "GET /api/v1/auth/me (authenticated)" "the account belongs to several centres: pass --slug"
      ;;
    *) bad "POST /api/v1/auth/login" "HTTP $STATUS code=$(json code)" ;;
  esac
  TOKEN=""
else
  skip "POST /api/v1/auth/login" "no credentials (set SMOKE_EMAIL and SMOKE_PASSWORD)"
  http GET "$API/api/v1/auth/me"
  if [ "$STATUS" = 401 ]; then ok "GET /api/v1/auth/me (no token)" "401 as expected"; else bad "GET /api/v1/auth/me (no token)" "HTTP $STATUS, expected 401"; fi
fi

# --- 4. CORS -----------------------------------------------------------------
if [ -n "$ALLOWED_ORIGIN" ]; then
  http OPTIONS "$API/api/v1/public/plans" -H "Origin: $ALLOWED_ORIGIN" -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization,content-type'
  ACAO="$(header access-control-allow-origin)"
  if [ "$ACAO" = "$ALLOWED_ORIGIN" ] && [ "$(header access-control-allow-credentials)" = true ]; then ok "CORS preflight from $ALLOWED_ORIGIN" "$STATUS allow-origin echoed, credentials allowed"
  else bad "CORS preflight from $ALLOWED_ORIGIN" "HTTP $STATUS access-control-allow-origin=\"$ACAO\" (is the origin one of the *_WEB_URL / CORS_ORIGINS values?)"; fi
else skip "CORS preflight from an allowed origin" "no --allowed-origin given"; fi

http OPTIONS "$API/api/v1/public/plans" -H "Origin: $DISALLOWED_ORIGIN" -H 'Access-Control-Request-Method: GET'
ACAO="$(header access-control-allow-origin)"
if [ -z "$ACAO" ]; then ok "CORS preflight from a disallowed origin" "HTTP $STATUS, no access-control-allow-origin header"
else bad "CORS preflight from a disallowed origin" "the API answered access-control-allow-origin=\"$ACAO\" for $DISALLOWED_ORIGIN"; fi

# --- 5. reverse-proxy only ---------------------------------------------------
if [ "$DIRECT" = 1 ]; then
  skip "/api/v1/internal/metrics is not public" "--direct: only meaningful through the public host name"
  skip "/api/v1/internal/tls/ask is not public" "--direct"
  skip "HTTP redirects to HTTPS" "--direct"
  skip "Security headers from the proxy" "--direct"
else
  # A request that reaches the API always carries x-request-id; a proxy refusal does not.
  for path in "/api/v1/internal/metrics" "/api/v1/internal/tls/ask?domain=smoke.invalid" "/api/v1/internal/"; do
    http GET "$API$path"
    name="${path%%\?*} is not public"
    if [ "$STATUS" = 000 ]; then bad "$name" "no response: $(curl_error)"
    elif [ -n "$(header x-request-id)" ] || [ "$STATUS" = 200 ] || [ "$STATUS" = 401 ]; then bad "$name" "HTTP $STATUS and the request REACHED the API: block /api/v1/internal/* at the proxy"
    else ok "$name" "HTTP $STATUS from the proxy, the API was not reached"; fi
  done
  case "$API" in
    https://*)
      http GET "http://${API#https://}/health"
      case "$STATUS" in
        301|308) ok "HTTP redirects to HTTPS" "$STATUS -> $(header location)" ;;
        *) bad "HTTP redirects to HTTPS" "HTTP $STATUS on plain http" ;;
      esac
      http GET "$API/health"
      missing=""
      header strict-transport-security | grep -qi 'max-age=[1-9]' || missing="$missing strict-transport-security"
      [ "$(header x-content-type-options | tr 'A-Z' 'a-z')" = nosniff ] || missing="$missing x-content-type-options"
      [ -n "$(header x-frame-options)" ] || missing="$missing x-frame-options"
      [ -n "$(header referrer-policy)" ] || missing="$missing referrer-policy"
      if [ -z "$missing" ]; then ok "Security headers from the proxy" "HSTS, nosniff, frame options, referrer policy"; else bad "Security headers from the proxy" "missing:$missing"; fi
      ;;
    *) skip "HTTP redirects to HTTPS" "target is not https"; skip "Security headers from the proxy" "target is not https" ;;
  esac
fi

# --- 6. web applications -----------------------------------------------------
for url in ${WEB_URLS[@]+"${WEB_URLS[@]}"}; do
  http GET "$url" -L
  if [ "$STATUS" != 000 ] && [ "$STATUS" -lt 500 ] && [ "$STATUS" != 404 ]; then ok "GET $url" "HTTP $STATUS"
  else bad "GET $url" "HTTP $STATUS $(curl_error)"; fi
done

echo
echo "Summary: $PASS PASS, $FAIL FAIL, $SKIP SKIP"
[ "$FAIL" -eq 0 ]
