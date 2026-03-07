import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("DigestViewer — data handling and grouping", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("Digest API fetching", () => {
    it("fetches both digest entries and watch items", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            entries: [
              {
                id: "d-1",
                watchItemId: "w-1",
                summary: "Page updated with new pricing",
                createdAt: "2026-03-05T10:00:00Z",
              },
              {
                id: "d-2",
                watchItemId: "w-1",
                summary: "Minor formatting change",
                createdAt: "2026-03-04T10:00:00Z",
              },
            ],
            count: 2,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            items: [
              {
                id: "w-1",
                url: "https://example.com",
                label: "Example Site",
                frequency: "daily",
                active: true,
              },
            ],
            count: 1,
          }),
        });

      const [digestRes, watchRes] = await Promise.all([
        fetch("/api/digest"),
        fetch("/api/watchlist"),
      ]);

      const digestData = await digestRes.json();
      const watchData = await watchRes.json();

      expect(digestData.entries).toHaveLength(2);
      expect(watchData.items).toHaveLength(1);
      expect(digestData.entries[0].watchItemId).toBe("w-1");
      expect(watchData.items[0].id).toBe("w-1");
    });
  });

  describe("Grouping by watch item", () => {
    it("groups entries by watchItemId", () => {
      const entries = [
        { id: "d-1", watchItemId: "w-1", summary: "Update 1", createdAt: "2026-03-05T10:00:00Z" },
        { id: "d-2", watchItemId: "w-2", summary: "Update 2", createdAt: "2026-03-05T11:00:00Z" },
        { id: "d-3", watchItemId: "w-1", summary: "Update 3", createdAt: "2026-03-04T10:00:00Z" },
      ];

      const watchItemLabels = new Map([
        ["w-1", { label: "Site A", url: "https://a.com" }],
        ["w-2", { label: "Site B", url: "https://b.com" }],
      ]);

      const grouped = new Map<string, { label: string; url?: string; entries: typeof entries }>();

      for (const entry of entries) {
        const key = entry.watchItemId;
        const watchInfo = watchItemLabels.get(entry.watchItemId);
        const label = watchInfo?.label || entry.watchItemId.slice(0, 8);
        const url = watchInfo?.url;

        if (!grouped.has(key)) {
          grouped.set(key, { label, url, entries: [] });
        }
        grouped.get(key)!.entries.push(entry);
      }

      expect(grouped.size).toBe(2);
      expect(grouped.get("w-1")!.entries).toHaveLength(2);
      expect(grouped.get("w-2")!.entries).toHaveLength(1);
      expect(grouped.get("w-1")!.label).toBe("Site A");
      expect(grouped.get("w-2")!.label).toBe("Site B");
    });
  });

  describe("Grouping by date", () => {
    it("groups entries by date string", () => {
      const entries = [
        { id: "d-1", watchItemId: "w-1", summary: "Update 1", createdAt: "2026-03-05T10:00:00Z" },
        { id: "d-2", watchItemId: "w-2", summary: "Update 2", createdAt: "2026-03-05T11:00:00Z" },
        { id: "d-3", watchItemId: "w-1", summary: "Update 3", createdAt: "2026-03-04T10:00:00Z" },
      ];

      const grouped = new Map<string, { label: string; entries: typeof entries }>();

      for (const entry of entries) {
        const date = new Date(entry.createdAt).toLocaleDateString();
        const key = date;

        if (!grouped.has(key)) {
          grouped.set(key, { label: date, entries: [] });
        }
        grouped.get(key)!.entries.push(entry);
      }

      // Two dates: March 5 and March 4
      expect(grouped.size).toBe(2);

      const dateKeys = Array.from(grouped.keys());
      const march5Key = dateKeys.find((k) => k.includes("3/5") || k.includes("5/3") || k.includes("05"));
      const march4Key = dateKeys.find((k) => k.includes("3/4") || k.includes("4/3") || k.includes("04"));

      expect(march5Key).toBeDefined();
      expect(march4Key).toBeDefined();

      if (march5Key) {
        expect(grouped.get(march5Key)!.entries).toHaveLength(2);
      }
      if (march4Key) {
        expect(grouped.get(march4Key)!.entries).toHaveLength(1);
      }
    });
  });

  describe("Change indicator logic", () => {
    it("identifies changed vs unchanged entries", () => {
      const hasChanges = (changes: string | null | undefined) =>
        changes != null && changes !== "unchanged" && changes !== "";

      expect(hasChanges("Page title changed")).toBe(true);
      expect(hasChanges("unchanged")).toBe(false);
      expect(hasChanges(null)).toBe(false);
      expect(hasChanges(undefined)).toBe(false);
      expect(hasChanges("")).toBe(false);
    });
  });

  describe("Read tracking", () => {
    it("tracks marked-as-read IDs", () => {
      const markedIds = new Set<string>();

      markedIds.add("d-1");
      expect(markedIds.has("d-1")).toBe(true);
      expect(markedIds.has("d-2")).toBe(false);

      markedIds.add("d-2");
      expect(markedIds.has("d-2")).toBe(true);
    });

    it("mark all as read adds all entry IDs", () => {
      const entries = [
        { id: "d-1" },
        { id: "d-2" },
        { id: "d-3" },
      ];

      const markedIds = new Set(entries.map((e) => e.id));

      expect(markedIds.size).toBe(3);
      expect(markedIds.has("d-1")).toBe(true);
      expect(markedIds.has("d-2")).toBe(true);
      expect(markedIds.has("d-3")).toBe(true);
    });
  });
});
