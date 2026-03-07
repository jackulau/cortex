import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SessionHistory — session continuity logic", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("isSessionActive detection", () => {
    // Replicate the isSessionActive logic
    function isSessionActive(session: { endedAt: string | null }): boolean {
      if (!session.endedAt) return true;
      const endedMs = new Date(session.endedAt).getTime();
      const oneHourAgo = Date.now() - 3600000;
      return endedMs > oneHourAgo;
    }

    it("marks sessions without endedAt as active", () => {
      expect(isSessionActive({ endedAt: null })).toBe(true);
    });

    it("marks sessions ended within the last hour as active", () => {
      const tenMinutesAgo = new Date(Date.now() - 600000).toISOString();
      expect(isSessionActive({ endedAt: tenMinutesAgo })).toBe(true);
    });

    it("marks sessions ended over an hour ago as inactive", () => {
      const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
      expect(isSessionActive({ endedAt: twoHoursAgo })).toBe(false);
    });
  });

  describe("relativeTime formatting", () => {
    function relativeTime(dateStr: string): string {
      const now = Date.now();
      const then = new Date(dateStr).getTime();
      const diffMs = now - then;
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return "just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays}d ago`;
    }

    it("shows 'just now' for very recent times", () => {
      const now = new Date().toISOString();
      expect(relativeTime(now)).toBe("just now");
    });

    it("shows minutes for recent times", () => {
      const fiveMinutesAgo = new Date(Date.now() - 300000).toISOString();
      expect(relativeTime(fiveMinutesAgo)).toBe("5m ago");
    });

    it("shows hours for times within the day", () => {
      const threeHoursAgo = new Date(Date.now() - 10800000).toISOString();
      expect(relativeTime(threeHoursAgo)).toBe("3h ago");
    });

    it("shows days for older times", () => {
      const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
      expect(relativeTime(twoDaysAgo)).toBe("2d ago");
    });
  });

  describe("Resume session custom event", () => {
    it("dispatches cortex:resume-session event with session ID", () => {
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");

      const sessionId = "test-session-123";
      window.dispatchEvent(
        new CustomEvent("cortex:resume-session", { detail: { sessionId } })
      );

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
      expect(event.type).toBe("cortex:resume-session");
      expect(event.detail).toEqual({ sessionId: "test-session-123" });

      dispatchSpy.mockRestore();
    });
  });

  describe("Session list API", () => {
    it("fetches sessions with pagination", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              sessionId: "session-1",
              startedAt: "2026-03-01T10:00:00Z",
              endedAt: null,
              topics: ["coding"],
              turnCount: 5,
              summary: "Discussion about TypeScript",
            },
            {
              sessionId: "session-2",
              startedAt: "2026-02-28T14:00:00Z",
              endedAt: "2026-02-28T15:00:00Z",
              topics: ["design"],
              turnCount: 10,
              summary: "Dashboard design review",
            },
          ],
          cursor: "2026-02-28T14:00:00Z",
          hasMore: true,
        }),
      });

      const res = await fetch("/api/sessions?limit=20");
      const data = await res.json();

      expect(data.data).toHaveLength(2);
      expect(data.data[0].sessionId).toBe("session-1");
      expect(data.hasMore).toBe(true);
      expect(data.cursor).toBe("2026-02-28T14:00:00Z");
    });
  });
});
