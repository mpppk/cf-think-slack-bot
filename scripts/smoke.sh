#!/usr/bin/env bash
#
# デプロイ後のスモークテスト。
#
# デプロイ済み Worker を外形から叩き、CI の unit テストでは検出できない
# 「デプロイに固有の壊れ方」を見る。具体的には
#   - Worker がそもそも起動しているか(/health)
#   - 署名検証の関門が生きているか(署名なし → 401)
#   - **GitHub Secrets → Worker の secret 同期が実際に効いているか**
#     (--with-challenge。`wrangler secret list` は名前しか返さないので、正しい名前で
#      値が入り実行時に読めていることは、署名を通してみるしか確かめようがない)
#
# 逆に**確かめられないこと**: GitHub に入れた値が Slack App の実物と一致しているか。
# CI は同じ値で Worker に書き込み同じ値で署名するため、両者は構成上必ず一致する。
# 実物との一致は Slack 自身が署名して送ってくる場合しか分からない
# (Event Subscriptions の Request URL が Verified になること。ADR 0025)。
#
# 使い方:
#   bash scripts/smoke.sh <BASE_URL> [--with-challenge]
#   bun run smoke            # production
#   bun run smoke:preview    # preview (challenge まで)
#
# --with-challenge を付けた場合、環境変数 SLACK_SIGNING_SECRET が必須。
# 未設定なら**スキップせずに失敗する**(「検査できなかった」が緑にならないように)。
#
# 全チェック成功で exit 0、1つでも失敗すると exit 1。
set -uo pipefail

WEBHOOK_PATH="/messengers/slack/webhook"

BASE_URL=""
WITH_CHALLENGE=0
for arg in "$@"; do
  case "$arg" in
    --with-challenge) WITH_CHALLENGE=1 ;;
    -*)
      echo "unknown option: $arg" >&2
      echo "usage: bash scripts/smoke.sh <BASE_URL> [--with-challenge]" >&2
      exit 2
      ;;
    *) BASE_URL="$arg" ;;
  esac
done

if [ -z "$BASE_URL" ]; then
  echo "usage: bash scripts/smoke.sh <BASE_URL> [--with-challenge]" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}" # 末尾スラッシュを除去

# 一過性の 5xx やデプロイ伝播中の揺らぎを吸収する
CURL_OPTS=(--silent --show-error --location --max-time 20 --retry 3 --retry-delay 2 --retry-connrefused)

pass=0
fail=0

ok() {
  printf '  ok    %s\n' "$1"
  pass=$((pass + 1))
}

ng() {
  printf '  FAIL  %s\n' "$1"
  fail=$((fail + 1))
}

echo "smoke: $BASE_URL"

# 1) Worker が起動しているか
status="$(curl "${CURL_OPTS[@]}" -o /tmp/smoke-health.txt -w '%{http_code}' "${BASE_URL}/health")"
if [ "$status" = "200" ] && grep -q '"ok":true' /tmp/smoke-health.txt; then
  ok "GET /health -> 200 {\"ok\":true}"
else
  ng "GET /health -> want=200 got=$status body=$(head -c 200 /tmp/smoke-health.txt)"
fi

# 2) 署名が無いリクエストを弾くか。
#    secret が未設定でも 401 になるので、これは「関門が開きっぱなしでない」ことの確認で
#    あって「secret が正しい」ことの確認ではない(後者は 4 の challenge)。
status="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' \
  -X POST -H 'content-type: application/json' \
  --data '{"type":"url_verification","challenge":"smoke"}' \
  "${BASE_URL}${WEBHOOK_PATH}")"
if [ "$status" = "401" ]; then
  ok "POST ${WEBHOOK_PATH} (署名なし) -> 401"
else
  ng "POST ${WEBHOOK_PATH} (署名なし) -> want=401 got=$status"
fi

# 3) 壊れた署名を弾くか
status="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' \
  -X POST -H 'content-type: application/json' \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -H 'x-slack-signature: v0=deadbeef' \
  --data '{"type":"url_verification","challenge":"smoke"}' \
  "${BASE_URL}${WEBHOOK_PATH}")"
if [ "$status" = "401" ]; then
  ok "POST ${WEBHOOK_PATH} (壊れた署名) -> 401"
else
  ng "POST ${WEBHOOK_PATH} (壊れた署名) -> want=401 got=$status"
fi

# 4) 正しい署名の url_verification に challenge を返すか。
#    デプロイ済み環境の secret と、ここで署名に使う secret が一致していないと通らない。
if [ "$WITH_CHALLENGE" = "1" ]; then
  if [ -z "${SLACK_SIGNING_SECRET:-}" ]; then
    ng "--with-challenge が指定されましたが SLACK_SIGNING_SECRET がありません"
  else
    challenge="smoke-$(date +%s)-$RANDOM"
    body="{\"type\":\"url_verification\",\"challenge\":\"${challenge}\"}"
    timestamp="$(date +%s)"
    # Slack と同じ署名方式: HMAC-SHA256("v0:{timestamp}:{body}") を hex で "v0=" に続ける
    digest="$(printf 'v0:%s:%s' "$timestamp" "$body" \
      | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex \
      | sed 's/^.*= //')"
    status="$(curl "${CURL_OPTS[@]}" -o /tmp/smoke-challenge.txt -w '%{http_code}' \
      -X POST -H 'content-type: application/json' \
      -H "x-slack-request-timestamp: ${timestamp}" \
      -H "x-slack-signature: v0=${digest}" \
      --data "$body" \
      "${BASE_URL}${WEBHOOK_PATH}")"
    got="$(cat /tmp/smoke-challenge.txt)"
    if [ "$status" = "200" ] && [ "$got" = "$challenge" ]; then
      ok "POST ${WEBHOOK_PATH} (正しい署名) -> 200 + challenge エコー"
    else
      # challenge 値そのものは秘密ではないが、署名や secret は出さない
      ng "POST ${WEBHOOK_PATH} (正しい署名) -> want=200/challenge got=$status/$(head -c 100 <<<"$got")"
    fi
  fi
fi

rm -f /tmp/smoke-health.txt /tmp/smoke-challenge.txt

echo "smoke: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
