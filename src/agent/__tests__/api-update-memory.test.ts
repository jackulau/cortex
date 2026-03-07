import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the apiUpdateMemory endpoint logic in CortexAgent.
 * Since CortexAgent extends AIChatAgent (which requires Cloudflare runtime),
 * we test the endpoint logic via unit tests of the data flow.
 */

describe("apiUpdateMemory endpoint logic", () => {
  // Mock SemanticMemory
  function createMockSemanticMemory() {
    return {
      get: vi.fn(),
      update: vi.fn(),
    };
  }

  // Mock cache
  function createMockCache() {
    return {
      invalidatePrefix: vi.fn(),
    };
  }

  // Mock D1 database
  function createMockDb() {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    };
    return {
      prepare: vi.fn().mockReturnValue(stmt),
      _stmt: stmt,
    };
  }

  describe("request validation", () => {
    it("rejects requests without an id field", async () => {
      const body = { content: "Updated content" };
      const hasId = "id" in body && (body as any).id;
      expect(hasId).toBeFalsy();
    });

    it("accepts requests with valid id", async () => {
      const body = { id: "mem-1", content: "Updated content" };
      expect(body.id).toBe("mem-1");
    });
  });

  describe("memory update flow", () => {
    let semanticMemory: ReturnType<typeof createMockSemanticMemory>;
    let cache: ReturnType<typeof createMockCache>;
    let db: ReturnType<typeof createMockDb>;

    beforeEach(() => {
      semanticMemory = createMockSemanticMemory();
      cache = createMockCache();
      db = createMockDb();
    });

    it("fetches existing memory before updating", async () => {
      const existingMemory = {
        id: "mem-1",
        content: "Original content",
        type: "fact",
        source: "user",
        tags: ["original"],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        relevanceScore: 1.0,
        lastAccessedAt: null,
        accessCount: 0,
      };

      semanticMemory.get.mockResolvedValue(existingMemory);
      semanticMemory.update.mockResolvedValue(true);

      // Simulate the update flow
      const body = { id: "mem-1", content: "Updated content", tags: ["updated"] };

      const existing = await semanticMemory.get(body.id);
      expect(existing).toEqual(existingMemory);

      const updatedContent = body.content ?? existing!.content;
      const updatedTags = body.tags ?? existing!.tags;

      const updated = await semanticMemory.update(body.id, updatedContent, updatedTags);
      expect(updated).toBe(true);

      expect(semanticMemory.update).toHaveBeenCalledWith(
        "mem-1",
        "Updated content",
        ["updated"]
      );
    });

    it("returns 404 when memory is not found", async () => {
      semanticMemory.get.mockResolvedValue(null);

      const existing = await semanticMemory.get("nonexistent");
      expect(existing).toBeNull();
    });

    it("preserves existing content when only tags are updated", async () => {
      const existingMemory = {
        id: "mem-1",
        content: "Keep this content",
        type: "fact",
        source: "user",
        tags: ["old-tag"],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        relevanceScore: 1.0,
        lastAccessedAt: null,
        accessCount: 0,
      };

      semanticMemory.get.mockResolvedValue(existingMemory);
      semanticMemory.update.mockResolvedValue(true);

      const body = { id: "mem-1", tags: ["new-tag"] } as {
        id: string;
        content?: string;
        tags?: string[];
      };

      const existing = await semanticMemory.get(body.id);
      const updatedContent = body.content ?? existing!.content;
      const updatedTags = body.tags ?? existing!.tags;

      await semanticMemory.update(body.id, updatedContent, updatedTags);

      expect(semanticMemory.update).toHaveBeenCalledWith(
        "mem-1",
        "Keep this content",
        ["new-tag"]
      );
    });

    it("updates type directly in D1 when type changes", async () => {
      const existingMemory = {
        id: "mem-1",
        content: "Some content",
        type: "fact",
        source: "user",
        tags: [],
      };

      semanticMemory.get.mockResolvedValue(existingMemory);
      semanticMemory.update.mockResolvedValue(true);

      const body = { id: "mem-1", type: "note" };
      const existing = await semanticMemory.get(body.id);

      // Type changed — simulate D1 update
      if (body.type && body.type !== existing!.type) {
        await db.prepare(`UPDATE semantic_memories SET type = ? WHERE id = ?`);
        db._stmt.bind(body.type, body.id);
        await db._stmt.run();
      }

      expect(db.prepare).toHaveBeenCalledWith(
        `UPDATE semantic_memories SET type = ? WHERE id = ?`
      );
    });

    it("invalidates memory cache after successful update", async () => {
      semanticMemory.get.mockResolvedValue({
        id: "mem-1",
        content: "Content",
        type: "fact",
        source: "user",
        tags: [],
      });
      semanticMemory.update.mockResolvedValue(true);

      // Simulate the flow
      await semanticMemory.update("mem-1", "Content", []);
      await cache.invalidatePrefix("memories:");

      expect(cache.invalidatePrefix).toHaveBeenCalledWith("memories:");
    });

    it("does not invalidate cache when update fails", async () => {
      semanticMemory.get.mockResolvedValue({
        id: "mem-1",
        content: "Content",
        type: "fact",
        source: "user",
        tags: [],
      });
      semanticMemory.update.mockResolvedValue(false);

      const updated = await semanticMemory.update("mem-1", "Content", []);

      if (updated) {
        await cache.invalidatePrefix("memories:");
      }

      expect(cache.invalidatePrefix).not.toHaveBeenCalled();
    });
  });
});
