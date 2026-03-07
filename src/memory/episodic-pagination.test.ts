import { describe, it, expect, vi, beforeEach } from "vitest";
import { EpisodicMemory } from "./episodic";
import type { SqlFn, SessionSummary } from "@/shared/types";

// ── Mock factory ─────────────────────────────────────────────

function createMockSql() {
  const fn = vi.fn().mockReturnValue([]) as unknown as SqlFn;
  return fn;
}

function mockSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "sess-1",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null as unknown as string,
    topics: [],
    turnCount: 0,
    summary: "",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("EpisodicMemory.listSessionsPaginated()", () => {
  let sql: ReturnType<typeof createMockSql>;
  let memory: EpisodicMemory;

  beforeEach(() => {
    sql = createMockSql();
    memory = new EpisodicMemory(sql);
  });

  it("returns paginated response with hasMore=false when fewer results than limit", () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      mockSession({ sessionId: "sess-1", startedAt: "2026-01-03T00:00:00Z" }),
      mockSession({ sessionId: "sess-2", startedAt: "2026-01-02T00:00:00Z" }),
    ]);

    const result = memory.listSessionsPaginated(10);

    expect(result.data).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("returns hasMore=true and cursor when more results exist", () => {
    // Simulate limit=2 but SQL returns 3 rows (limit+1 pattern)
    (sql as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      mockSession({ sessionId: "sess-1", startedAt: "2026-01-03T00:00:00Z" }),
      mockSession({ sessionId: "sess-2", startedAt: "2026-01-02T00:00:00Z" }),
      mockSession({ sessionId: "sess-3", startedAt: "2026-01-01T00:00:00Z" }),
    ]);

    const result = memory.listSessionsPaginated(2);

    expect(result.data).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    // Cursor should be the startedAt of the last returned item
    expect(result.cursor).toBe("2026-01-02T00:00:00Z");
  });

  it("returns empty data when no sessions exist", () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = memory.listSessionsPaginated(20);

    expect(result.data).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
  });

  it("accepts a cursor parameter for pagination", () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      mockSession({ sessionId: "sess-4", startedAt: "2025-12-31T00:00:00Z" }),
    ]);

    const result = memory.listSessionsPaginated(20, "2026-01-01T00:00:00Z");

    expect(result.data).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeNull();
    // sql should have been called (the tagged template invocation)
    expect(sql).toHaveBeenCalled();
  });

  it("defaults to limit 20", () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);

    memory.listSessionsPaginated();

    // sql should have been called
    expect(sql).toHaveBeenCalled();
  });

  it("does not include the overflow row in returned data", () => {
    const sessions = Array.from({ length: 6 }, (_, i) =>
      mockSession({
        sessionId: `sess-${i}`,
        startedAt: `2026-01-${String(10 - i).padStart(2, "0")}T00:00:00Z`,
      })
    );
    (sql as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sessions);

    const result = memory.listSessionsPaginated(5);

    // Should only return 5 items even though SQL returned 6
    expect(result.data).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    // The 6th session should not be in the data
    expect(result.data.find((s) => s.sessionId === "sess-5")).toBeUndefined();
  });
});
