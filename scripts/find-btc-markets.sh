#!/usr/bin/env bash
# Usage: ./scripts/find-btc-markets.sh [KEYWORD]
#
# Paginates through all active Polymarket CLOB markets and prints every market
# whose question contains KEYWORD (default: "BTC").
#
# Output:
#   - Human-readable market list with parsed token IDs
#   - A ready-to-paste POLYMARKET_TOKEN_IDS= line for .env
#
# Requirements: curl, jq

set -euo pipefail

KEYWORD="${1:-BTC}"
BASE="https://gamma-api.polymarket.com"
LIMIT=100
OFFSET=0
FOUND=0

echo "Scanning active CLOB markets for: \"$KEYWORD\"" >&2
echo "────────────────────────────────────────────────" >&2

ALL_TOKEN_IDS=()

while true; do
  PAGE=$(curl -sf \
    "${BASE}/markets?active=true&closed=false&archived=false&enableOrderBook=true&limit=${LIMIT}&offset=${OFFSET}")

  COUNT=$(echo "$PAGE" | jq 'length')

  if [[ "$COUNT" -eq 0 ]]; then
    break
  fi

  # Parse each matching market.
  # clobTokenIds arrives as a stringified JSON array ("[\"..\",\"..\"]") — use
  # 'if type == "string" then fromjson else . end' to handle both old and new API
  # responses gracefully.
  MATCHES=$(echo "$PAGE" | jq -r --arg kw "$KEYWORD" '
    .[] |
    select(.question | ascii_downcase | contains($kw | ascii_downcase)) |
    [
      "QUESTION : \(.question)",
      "CONDITION: \(.conditionId // "n/a")",
      "TOKENS   : \(.clobTokenIds | if type == "string" then fromjson else . end | join(","))",
      ""
    ] | join("\n")
  ')

  if [[ -n "$MATCHES" ]]; then
    echo "$MATCHES"
    # Accumulate token IDs for the .env line at the end
    while IFS= read -r line; do
      [[ "$line" == TOKENS* ]] && ALL_TOKEN_IDS+=("${line#TOKENS   : }")
    done <<< "$MATCHES"
    FOUND=$((FOUND + 1))
  fi

  # If fewer results than limit, we've reached the last page
  if [[ "$COUNT" -lt "$LIMIT" ]]; then
    break
  fi

  OFFSET=$((OFFSET + LIMIT))
done

echo "────────────────────────────────────────────────" >&2
echo "Found $FOUND matching market(s)." >&2
echo "" >&2

if [[ ${#ALL_TOKEN_IDS[@]} -gt 0 ]]; then
  # Join all token IDs (each entry is already comma-separated within a market)
  JOINED=$(IFS=,; echo "${ALL_TOKEN_IDS[*]}")
  echo "Paste into .env:"
  echo "  POLYMARKET_TOKEN_IDS=${JOINED}"
else
  echo "No markets found. Try a different keyword:"
  echo "  $0 Bitcoin"
  echo "  $0 \"15 min\""
  echo "  $0 crypto"
fi
