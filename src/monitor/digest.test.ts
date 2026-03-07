import { describe, it, expect, vi, beforeEach } from "vitest";
import { DigestManager } from "./digest";

// ── Mock D1 Database ──────────────────────────────────────────

function createMockDb() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
  };

  const db = {
    prepare: vi.fn().mockReturnValue(mockStmt),
    batch: vi.fn().mockResolvedValue([]),
    _stmt: mockStmt,
  };

  return db as any;
}

function createMockAi() {
  return {
    run: vi.fn().mockResolvedValue({ response: "Formatted digest content" }),
  } as any;
}

// ── Mock Data ────────────────────────────────────────────────

const mockRawEntries = [
  {
    id: "entry-1",
    watch_item_id: "watch-1",
    summary: "Page updated with new pricing",
    changes: "Pricing section changed",
    delivered: 0,
    created_at: "2024-01-15T10:00:00Z",
    namespace_id: "default",
    label: "Competitor Pricing",
    url: "https://competitor.com/pricing",
  },
  {
    id: "entry-2",
    watch_item_id: "watch-1",
    summary: "New blog post about features",
    changes: "Blog section updated",
    delivered: 0,
    created_at: "2024-01-15T11:00:00Z",
    namespace_id: "default",
    label: "Competitor Pricing",
    url: "https://competitor.com/pricing",
  },
  {
    id: "entry-3",
    watch_item_id: "watch-2",
    summary: "API docs updated",
    changes: null,
    delivered: 0,
    created_at: "2024-01-15T12:00:00Z",
    namespace_id: "default",
    label: "API Docs",
    url: "https://api.example.com/docs",
  },
];

// ── Tests ────────────────────────────────────────────────────

describe("DigestManager", () => {
  let db: ReturnType<typeof createMockDb>;
  let manager: DigestManager;

  beforeEach(() => {
    db = createMockDb();
    manager = new DigestManager(db);
  });

  describe("constructor", () => {
    it("defaults to 'default' namespace", () => {
      expect(manager.getNamespaceId()).toBe("default");
    });

    it("accepts a custom namespace", () => {
      const custom = new DigestManager(db, "team-gamma");
      expect(custom.getNamespaceId()).toBe("team-gamma");
    });
  });

  describe("getUndelivered", () => {
    it("queries for undelivered entries scoped to namespace", async () => {
      db._stmt.all.mockResolvedValue({ results: mockRawEntries });

      const entries = await manager.getUndelivered();

      expect(entries).toHaveLength(3);
      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("delivered = 0");
      expect(sql).toContain("de.namespace_id = ?");
      expect(sql).toContain("JOIN watch_items");
      expect(db._stmt.bind).toHaveBeenCalledWith("default");
    });

    it("converts snake_case to camelCase including namespaceId", async () => {
      db._stmt.all.mockResolvedValue({ results: [mockRawEntries[0]] });

      const entries = await manager.getUndelivered();
      expect(entries[0].watchItemId).toBe("watch-1");
      expect(entries[0].delivered).toBe(false);
      expect(entries[0].createdAt).toBe("2024-01-15T10:00:00Z");
      expect(entries[0].namespaceId).toBe("default");
    });

    it("returns empty array when no entries", async () => {
      db._stmt.all.mockResolvedValue({ results: [] });
      const entries = await manager.getUndelivered();
      expect(entries).toHaveLength(0);
    });
  });

  describe("getByWatchItem", () => {
    it("queries entries scoped to namespace", async () => {
      db._stmt.all.mockResolvedValue({ results: [mockRawEntries[0]] });

      const entries = await manager.getByWatchItem("watch-1");

      expect(entries).toHaveLength(1);
      expect(db._stmt.bind).toHaveBeenCalledWith("watch-1", "default");
      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("watch_item_id = ?");
      expect(sql).toContain("namespace_id = ?");
    });
  });

  describe("markDelivered", () => {
    it("batches update statements scoped to namespace", async () => {
      await manager.markDelivered(["entry-1", "entry-2"]);

      expect(db.prepare).toHaveBeenCalledTimes(2);
      expect(db.batch).toHaveBeenCalledTimes(1);

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("UPDATE digest_entries SET delivered = 1");
      expect(sql).toContain("namespace_id = ?");
    });

    it("does nothing for empty array", async () => {
      await manager.markDelivered([]);
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
    });
  });

  describe("addEntry", () => {
    it("inserts a new digest entry with namespace", async () => {
      const id = await manager.addEntry({
        watchItemId: "watch-1",
        summary: "Something changed",
        changes: "Details here",
      });

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("INSERT INTO digest_entries");
      expect(sql).toContain("namespace_id");
      expect(db._stmt.bind).toHaveBeenCalledWith(
        id,
        "watch-1",
        "Something changed",
        "Details here",
        "default"
      );
    });

    it("passes null for missing changes", async () => {
      await manager.addEntry({
        watchItemId: "watch-1",
        summary: "Changed",
      });

      expect(db._stmt.bind).toHaveBeenCalledWith(
        expect.any(String),
        "watch-1",
        "Changed",
        null,
        "default"
      );
    });
  });

  describe("generateDigest", () => {
    it("returns no-updates message when nothing to deliver", async () => {
      db._stmt.all.mockResolvedValue({ results: [] });
      const ai = createMockAi();

      const digest = await manager.generateDigest(ai, "test-model");
      expect(digest).toBe("No new updates to report.");
      expect(ai.run).not.toHaveBeenCalled();
    });

    it("calls AI to format digest and marks entries delivered", async () => {
      db._stmt.all.mockResolvedValueOnce({ results: mockRawEntries });
      const ai = createMockAi();

      const digest = await manager.generateDigest(ai, "test-model");

      expect(digest).toBe("Formatted digest content");
      expect(ai.run).toHaveBeenCalledWith("test-model", {
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({ role: "user" }),
        ]),
      });

      // Verify markDelivered was called
      expect(db.batch).toHaveBeenCalled();
    });

    it("groups entries by watch item for formatting", async () => {
      db._stmt.all.mockResolvedValueOnce({ results: mockRawEntries });
      const ai = createMockAi();

      await manager.generateDigest(ai, "test-model");

      const userMessage = ai.run.mock.calls[0][1].messages[1].content;
      expect(userMessage).toContain("Competitor Pricing");
      expect(userMessage).toContain("API Docs");
    });
  });

  describe("namespace isolation", () => {
    it("different namespace managers produce different queries", async () => {
      const nsA = new DigestManager(db, "ns-a");
      const nsB = new DigestManager(db, "ns-b");

      db._stmt.all.mockResolvedValue({ results: [] });

      await nsA.getUndelivered();
      expect(db._stmt.bind).toHaveBeenLastCalledWith("ns-a");

      await nsB.getUndelivered();
      expect(db._stmt.bind).toHaveBeenLastCalledWith("ns-b");
    });
  });
});
