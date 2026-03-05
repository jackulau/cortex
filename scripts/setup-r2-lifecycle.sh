#!/usr/bin/env bash
# Setup R2 bucket lifecycle policies for cortex-storage.
# Run once after bucket creation to auto-expire old objects.

set -euo pipefail

echo "Setting lifecycle rule: cleanup-exports (30 days)..."
wrangler r2 bucket lifecycle set cortex-storage \
  --rule '{"id":"cleanup-exports","prefix":"exports/","expiration":{"days":30}}'

echo "Setting lifecycle rule: cleanup-screenshots (90 days)..."
wrangler r2 bucket lifecycle set cortex-storage \
  --rule '{"id":"cleanup-screenshots","prefix":"screenshots/","expiration":{"days":90}}'

echo "R2 lifecycle policies configured."
