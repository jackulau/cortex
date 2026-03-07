#!/usr/bin/env bash
# Setup R2 bucket lifecycle policies for cortex-storage.
# Run once after bucket creation to auto-expire old objects.
#
# Lifecycle rules:
#   exports/      — expire after 30 days (temporary export downloads)
#   screenshots/  — expire after 14 days (browser rendering captures)
#   archives/     — expire after 90 days (long-term archive storage)
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - CLOUDFLARE_ACCOUNT_ID set or configured in wrangler.jsonc
#
# Usage:
#   ./scripts/setup-r2-lifecycle.sh

set -euo pipefail

BUCKET_NAME="cortex-storage"

echo "Setting R2 lifecycle rules for bucket: ${BUCKET_NAME}"
echo ""

echo "Setting lifecycle rule: cleanup-exports (30 days)..."
wrangler r2 bucket lifecycle set "${BUCKET_NAME}" \
  --rule '{"id":"cleanup-exports","prefix":"exports/","expiration":{"days":30}}'

echo "Setting lifecycle rule: cleanup-screenshots (14 days)..."
wrangler r2 bucket lifecycle set "${BUCKET_NAME}" \
  --rule '{"id":"cleanup-screenshots","prefix":"screenshots/","expiration":{"days":14}}'

echo "Setting lifecycle rule: cleanup-archives (90 days)..."
wrangler r2 bucket lifecycle set "${BUCKET_NAME}" \
  --rule '{"id":"cleanup-archives","prefix":"archives/","expiration":{"days":90}}'

echo ""
echo "R2 lifecycle policies configured:"
echo "  - exports/      -> expire after 30 days"
echo "  - screenshots/  -> expire after 14 days"
echo "  - archives/     -> expire after 90 days"
echo ""
echo "Verify with: wrangler r2 bucket lifecycle list ${BUCKET_NAME}"
