#!/usr/bin/env bash
#
# Create the Vectorize index for Cortex semantic memory.
#
# The embedding model @cf/baai/bge-large-en-v1.5 produces 1024-dimension vectors.
# We use cosine similarity as the distance metric.
#
# Usage:
#   ./scripts/setup-vectorize.sh
#

set -euo pipefail

INDEX_NAME="cortex-memories"
DIMENSIONS=1024
METRIC="cosine"

echo "Creating Vectorize index '${INDEX_NAME}'..."
echo "  Dimensions: ${DIMENSIONS}"
echo "  Metric:     ${METRIC}"
echo ""

npx wrangler vectorize create "${INDEX_NAME}" \
  --dimensions="${DIMENSIONS}" \
  --metric="${METRIC}"

echo ""
echo "Vectorize index '${INDEX_NAME}' created successfully."
echo ""
echo "Next steps:"
echo "  1. Run the migration to backfill existing embeddings from D1."
echo "  2. The VECTORIZE binding in wrangler.jsonc is already configured."
