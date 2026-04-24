#!/usr/bin/env bash
# Usage: ./scripts/find-btc-markets.sh [SLUG_PATTERN]
#
# Paginates through all active Polymarket CLOB markets and prints every market
# whose `slug` matches SLUG_PATTERN (a case-insensitive ERE regex).
#
# Slugs are machine-generated (kebab-case) and more reliable for programmatic
# matching than free-text question strings. Examples:
#   btc-up-or-down-in-15-minutes-jan-15-12-00
#   bitcoin-15-minute-price-prediction-2025-01-15
#
# Output:
#   - Human-readable market list (slug, question, condition ID, token IDs)
#   - A ready-to-paste POLYMARKET_TOKEN_IDS= line for .env
#
# Requirements: curl, jq

set -euo pipefail

# Real BTC 15-min up/down slug format: btc-updown-15m-{unix_timestamp}
# e.g. btc-updown-15m-1777049100 (timestamp increments by 900 s per market)
SLUG_PATTERN="${1:-btc-updown-15m}"
BASE="https://gamma-api.polymarket.com"
LIMIT=100
OFFSET=0
FOUND=0

echo "Scanning active CLOB markets — slug pattern: \"${SLUG_PATTERN}\"" >&2
echo "────────────────────────────────────────────────────────────────" >&2

ALL_TOKEN_IDS=()

while true; do
  PAGE=$(curl -sf \
    "${BASE}/markets?active=true&closed=false&archived=false&enableOrderBook=true&limit=${LIMIT}&offset=${OFFSET}")

  COUNT=$(echo "$PAGE" | jq 'length')

  if [[ "$COUNT" -eq 0 ]]; then
    break
  fi

  # Filter by slug regex. clobTokenIds is a stringified JSON array —
  # 'if type == "string" then fromjson else . end' handles both API formats.
  MATCHES=$(echo "$PAGE" | jq -r --arg pat "$SLUG_PATTERN" '
    .[] |
    select(.slug != null and (.slug | test($pat; "i"))) |
    [
      "SLUG     : \(.slug)",
      "QUESTION : \(.question)",
      "CONDITION: \(.conditionId // "n/a")",
      "TOKENS   : \(.clobTokenIds | if type == "string" then fromjson else . end | join(","))",
      ""
    ] | join("\n")
  ')

  if [[ -n "$MATCHES" ]]; then
    echo "$MATCHES"
    while IFS= read -r line; do
      [[ "$line" == TOKENS* ]] && ALL_TOKEN_IDS+=("${line#TOKENS   : }")
    done <<< "$MATCHES"
    FOUND=$((FOUND + 1))
  fi

  if [[ "$COUNT" -lt "$LIMIT" ]]; then
    break
  fi

  OFFSET=$((OFFSET + LIMIT))
done

echo "────────────────────────────────────────────────────────────────" >&2
echo "Found ${FOUND} matching market(s)." >&2
echo "" >&2

if [[ ${#ALL_TOKEN_IDS[@]} -gt 0 ]]; then
  JOINED=$(IFS=,; echo "${ALL_TOKEN_IDS[*]}")
  echo "Paste into .env:"
  echo "  POLYMARKET_TOKEN_IDS=${JOINED}"
  echo ""
  echo "Or set the slug pattern directly (auto-discovery will use it):"
  echo "  POLYMARKET_SLUG_PATTERN=${SLUG_PATTERN}"
else
  echo "No markets found. Inspect available slugs first:"
  echo "  curl -s '${BASE}/markets?active=true&closed=false&enableOrderBook=true&limit=20' | jq '.[].slug'"
  echo ""
  echo "Then refine your pattern:"
  echo "  $0 'btc.*15'"
  echo "  $0 'bitcoin.*minute'"
fi
