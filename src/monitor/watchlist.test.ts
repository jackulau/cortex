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

  describe("add", () => {
    it("inserts a watch item and returns a UUID", async () => {
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
      expect(db._stmt.bind).toHaveBeenCalledWith(
        id,
        "https://example.com",
        "Example",
        "daily"
      );
      expect(db._stmt.run).toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("returns true when a row is deleted", async () => {
      db._setMeta({ changes: 1 });
      const result = await manager.remove("some-id");
      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM watch_items")
      );
    });

    it("returns false when no row matches", async () => {
      db._setMeta({ changes: 0 });
      const result = await manager.remove("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("list", () => {
    it("queries active items by default", async () => {
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
          },
        ],
      });

      const items = await manager.list();

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("item-1");
      expect(items[0].active).toBe(true);
      expect(items[0].lastChecked).toBeNull();

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("WHERE active = 1");
    });

    it("returns all items when activeOnly is false", async () => {
      db._stmt.all.mockResolvedValue({ results: [] });
      await manager.list(false);

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).not.toContain("WHERE active = 1");
    });

    it("converts snake_case to camelCase", async () => {
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
          },
        ],
      });

      const items = await manager.list(false);
      expect(items[0].lastChecked).toBe("2024-01-01T00:00:00Z");
      expect(items[0].lastHash).toBe("abc123");
      expect(items[0].active).toBe(false);
      expect(items[0].createdAt).toBe("2024-01-01T00:00:00Z");
    });
  });

  describe("get", () => {
    it("returns null when item not found", async () => {
      db._stmt.first.mockResolvedValue(null);
      const result = await manager.get("missing-id");
      expect(result).toBeNull();
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
      });

      const result = await manager.get("item-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("item-1");
      expect(result!.frequency).toBe("hourly");
    });
  });

  describe("getDueItems", () => {
    it("uses the correct frequency-based SQL query", async () => {
      db._stmt.all.mockResolvedValue({ results: [] });
      await manager.getDueItems();

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("active = 1");
      expect(sql).toContain("last_checked IS NULL");
      expect(sql).toContain("frequency = 'hourly'");
      expect(sql).toContain("datetime('now', '-1 hour')");
      expect(sql).toContain("frequency = 'daily'");
      expect(sql).toContain("datetime('now', '-1 day')");
      expect(sql).toContain("frequency = 'weekly'");
      expect(sql).toContain("datetime('now', '-7 days')");
    });

    it("returns mapped watch items", async () => {
      db._stmt.all.mockResolvedValue({
        results: [
          {
            id: "due-1",
            url: "https://due.com",
            label: "Due Item",
            frequency: "daily",
            last_checked: null,
            last_hash: null,
            active: 1,
            created_at: "2024-01-01T00:00:00Z",
          },
        ],
      });

      const items = await manager.getDueItems();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("due-1");
      expect(items[0].url).toBe("https://due.com");
    });
  });

  describe("updateLastChecked", () => {
    it("updates last_checked and last_hash", async () => {
      await manager.updateLastChecked("item-1", "sha256hash");

      const sql = db.prepare.mock.calls[0][0];
      expect(sql).toContain("UPDATE watch_items");
      expect(sql).toContain("last_checked = datetime('now')");
      expect(sql).toContain("last_hash = ?");
      expect(db._stmt.bind).toHaveBeenCalledWith("sha256hash", "item-1");
    });
  });
});
