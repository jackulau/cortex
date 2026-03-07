import { describe, it, expect, vi, beforeEach } from "vitest";
import { WatchListManager } from "./watchlist";

// ── Mock D1 Database ──────────────────────────────────────────

function createMockDb() {
  const rows: any[] = [];
  let lastMeta = { changes: 0 };

  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: lastMeta }),
    all: vi.fn().mockResolvedValue({ results: rows }),
    first: vi.fn().mockResolvedValue(null),
  };

  const db = {
    prepare: vi.fn().mockReturnValue(mockStmt),
    batch: vi.fn().mockResolvedValue([]),
    _stmt: mockStmt,
    _rows: rows,
    _setMeta: (meta: any) => {
      lastMeta.changes = meta.changes;
    },
  };

  return db as any;
}

// ── Tests ────────────────────────────────────────────────────

describe("WatchListManager", () => {
  let db: ReturnType<typeof createMockDb>;
  let manager: WatchListManager;

  beforeEach(() => {
    db = createMockDb();
    manager = new WatchListManager(db);
  });

  describe("constructor", () => {
    it("defaults to 'default' namespace", () => {
      expect(manager.getNamespaceId()).toBe("default");
    });

    it("accepts a custom namespace", () => {
      const custom = new WatchListManager(db, "team-beta");
      expect(custom.getNamespaceId()).toBe("team-beta");
    });
  });

  describe("add", () => {
    it("inserts a watch item with namespace and returns a UUID", async () => {
      const id = await manager.add({
        url: "https://example.com",
        label: "Example",
        frequency: "daily",
      });

      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO watch_items")
      );
      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("namespace_id");
      expect(db._stmt.bind).toHaveBeenCalledWith(
        id,
        "https://example.com",
        "Example",
        "daily",
        "default"
      );
      expect(db._stmt.run).toHaveBeenCalled();
    });

    it("uses custom namespace in insert", async () => {
      const custom = new WatchListManager(db, "project-x");
      const id = await custom.add({
        url: "https://example.com",
        label: "PX Watch",
        frequency: "hourly",
      });

      expect(db._stmt.bind).toHaveBeenCalledWith(
        id,
        "https://example.com",
        "PX Watch",
        "hourly",
        "project-x"
      );
    });
  });

  describe("remove", () => {
    it("returns true when a row is deleted with namespace scoping", async () => {
      db._setMeta({ changes: 1 });
      const result = await manager.remove("some-id");
      expect(result).toBe(true);
      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("DELETE FROM watch_items");
      expect(sql).toContain("namespace_id = ?");
      expect(db._stmt.bind).toHaveBeenCalledWith("some-id", "default");
    });

    it("returns false when no row matches", async () => {
      db._setMeta({ changes: 0 });
      const result = await manager.remove("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("list", () => {
    it("queries items with namespace scoping", async () => {
      db._stmt.all.mockResolvedValue({
        results: [
          {
            id: "item-1",
            url: "https://example.com",
            label: "Test",
            frequency: "daily",
            last_checked: null,
            last_hash: null,
            active: 1,
            created_at: "2024-01-01T00:00:00Z",
            namespace_id: "default",
          },
        ],
      });

      const items = await manager.list();

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("item-1");
      expect(items[0].active).toBe(true);
      expect(items[0].namespaceId).toBe("default");

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("namespace_id = ?");
      expect(sql).toContain("active = 1");
      expect(db._stmt.bind).toHaveBeenCalledWith("default");
    });

    it("returns all items (including inactive) when activeOnly is false", async () => {
      db._stmt.all.mockResolvedValue({ results: [] });
      await manager.list(false);

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("namespace_id = ?");
      expect(sql).not.toContain("active = 1");
    });

    it("converts snake_case to camelCase including namespaceId", async () => {
      db._stmt.all.mockResolvedValue({
        results: [
          {
            id: "item-1",
            url: "https://example.com",
            label: "Test",
            frequency: "weekly",
            last_checked: "2024-01-01T00:00:00Z",
            last_hash: "abc123",
            active: 0,
            created_at: "2024-01-01T00:00:00Z",
            namespace_id: "default",
          },
        ],
      });

      const items = await manager.list(false);
      expect(items[0].lastChecked).toBe("2024-01-01T00:00:00Z");
      expect(items[0].lastHash).toBe("abc123");
      expect(items[0].active).toBe(false);
      expect(items[0].namespaceId).toBe("default");
    });
  });

  describe("get", () => {
    it("returns null when item not found with namespace scoping", async () => {
      db._stmt.first.mockResolvedValue(null);
      const result = await manager.get("missing-id");
      expect(result).toBeNull();

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("namespace_id = ?");
      expect(db._stmt.bind).toHaveBeenCalledWith("missing-id", "default");
    });

    it("returns the watch item when found", async () => {
      db._stmt.first.mockResolvedValue({
        id: "item-1",
        url: "https://example.com",
        label: "Test",
        frequency: "hourly",
        last_checked: null,
        last_hash: null,
        active: 1,
        created_at: "2024-01-01T00:00:00Z",
        namespace_id: "default",
      });

      const result = await manager.get("item-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("item-1");
      expect(result!.frequency).toBe("hourly");
      expect(result!.namespaceId).toBe("default");
    });
  });

  describe("getDueItems", () => {
    it("uses the correct frequency-based SQL query with namespace", async () => {
      db._stmt.all.mockResolvedValue({ results: [] });
      await manager.getDueItems();

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("active = 1");
      expect(sql).toContain("namespace_id = ?");
      expect(sql).toContain("last_checked IS NULL");
      expect(sql).toContain("frequency = 'hourly'");
      expect(sql).toContain("frequency = 'daily'");
      expect(sql).toContain("frequency = 'weekly'");
      expect(db._stmt.bind).toHaveBeenCalledWith("default");
    });
  });

  describe("setActive", () => {
    it("updates active status with namespace scoping", async () => {
      await manager.setActive("item-1", false);

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("UPDATE watch_items");
      expect(sql).toContain("namespace_id = ?");
      expect(db._stmt.bind).toHaveBeenCalledWith(0, "item-1", "default");
    });
  });

  describe("updateLastChecked", () => {
    it("updates last_checked and last_hash with namespace scoping", async () => {
      await manager.updateLastChecked("item-1", "sha256hash");

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("UPDATE watch_items");
      expect(sql).toContain("namespace_id = ?");
      expect(db._stmt.bind).toHaveBeenCalledWith("sha256hash", "item-1", "default");
    });
  });
});
