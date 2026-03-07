#!/usr/bin/env bash
# Configure R2 lifecycle policy for cortex-storage bucket.
#
# This script sets up an auto-cleanup rule that deletes objects
# with the "exports/" prefix after 30 days, preventing unbounded
# storage growth.
#
# Prerequisites:
#   - CLOUDFLARE_ACCOUNT_ID environment variable
#   - CLOUDFLARE_API_TOKEN environment variable (with R2 admin scope)
#
# Usage:
#   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx ./scripts/r2-lifecycle.sh

set -euo pipefail

BUCKET_NAME="cortex-storage"
EXPIRATION_DAYS=30
RULE_ID="auto-cleanup-exports"

# ── Validate env ─────────────────────────────────────────────────
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "Error: CLOUDFLARE_ACCOUNT_ID is required" >&2
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "Error: CLOUDFLARE_API_TOKEN is required" >&2
  exit 1
fi

API_BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/lifecycle"

echo "Configuring R2 lifecycle policy on bucket '${BUCKET_NAME}'..."
echo "  Rule: ${RULE_ID}"
echo "  Prefix: exports/"
echo "  Expiration: ${EXPIRATION_DAYS} days"

# ── Apply lifecycle rule ─────────────────────────────────────────
# The R2 lifecycle API expects a PUT with the full set of rules.
RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT "${API_BASE}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @- <<EOF
{
  "rules": [
    {
      "id": "${RULE_ID}",
      "enabled": true,
      "conditions": {
        "prefix": "exports/"
      },
      "action": {
        "type": "DeleteObject",
        "deleteAfterDays": ${EXPIRATION_DAYS}
      }
    }
  ]
}
EOF
)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Lifecycle policy applied successfully (HTTP ${HTTP_CODE})."
else
  echo "Error applying lifecycle policy (HTTP ${HTTP_CODE}):" >&2
  echo "$BODY" >&2
  exit 1
fi
