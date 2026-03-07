#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# R2 Event Notifications Setup
# ──────────────────────────────────────────────────────────────
# Configures R2 event notifications on the cortex-storage bucket
# to send object-create events to the cortex-r2-events queue.
#
# Prerequisites:
#   - wrangler CLI authenticated
#   - cortex-r2-events queue created (wrangler queues create cortex-r2-events)
#   - CLOUDFLARE_ACCOUNT_ID env var set
#
# Usage:
#   CLOUDFLARE_ACCOUNT_ID=<your-account-id> bash scripts/r2-event-notifications.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail

BUCKET_NAME="cortex-storage"
QUEUE_NAME="cortex-r2-events"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID env var}"

echo "Creating queue: ${QUEUE_NAME}..."
wrangler queues create "${QUEUE_NAME}" 2>/dev/null || echo "Queue already exists"

echo ""
echo "Configuring R2 event notifications on bucket: ${BUCKET_NAME}..."
echo ""
echo "NOTE: R2 event notifications must be configured via the Cloudflare Dashboard"
echo "or the Cloudflare API. Wrangler does not yet support R2 event notification setup."
echo ""
echo "Dashboard steps:"
echo "  1. Go to R2 > cortex-storage > Settings > Event notifications"
echo "  2. Click 'Add notification'"
echo "  3. Set event type: object-create (PutObject, CopyObject, CompleteMultipartUpload)"
echo "  4. Set prefix filter: exports/"
echo "  5. Set destination queue: cortex-r2-events"
echo "  6. Save"
echo ""
echo "Or use the Cloudflare API:"
echo "  curl -X PUT \\"
echo "    'https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/event_notifications/r2/${BUCKET_NAME}/configuration/queues/${QUEUE_NAME}' \\"
echo "    -H 'Authorization: Bearer <API_TOKEN>' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{"
echo "      \"rules\": [{"
echo "        \"actions\": [\"PutObject\", \"CopyObject\", \"CompleteMultipartUpload\"],"
echo "        \"prefix\": \"exports/\""
echo "      }]"
echo "    }'"
echo ""
echo "Done."
