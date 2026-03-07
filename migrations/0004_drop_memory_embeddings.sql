-- Drop the legacy memory_embeddings table.
-- Embeddings are now stored exclusively in Cloudflare Vectorize.
-- D1 (semantic_memories) remains the source of truth for metadata.
DROP TABLE IF EXISTS memory_embeddings;
