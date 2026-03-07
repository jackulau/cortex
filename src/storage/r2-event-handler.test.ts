import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processR2EventMessage,
  isR2EventMessage,
  type R2EventMessage,
} from "./r2-event-handler";
import type { Env } from "@/shared/types";

// ── Mock factories ───────────────────────────────────────────

function createMockAnalyticsEngine() {
  return {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset;
}

function createMockEnv(
  overrides: Partial<Env> = {}
): Env {
  return {
    ANALYTICS: createMockAnalyticsEngine(),
    ...overrides,
  } as unknown as Env;
}

function createR2EventMessage(
  overrides: Partial<R2EventMessage> = {}
): R2EventMessage {
  return {
    account: "test-account-id",
    bucket: "cortex-storage",
    object: {
      key: "exports/markdown-obsidian-2026-03-06.md",
      size: 4096,
      eTag: "abc123",
    },
    action: "PutObject",
    eventTime: "2026-03-06T12:00:00Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("R2 Event Handler", () => {
  let env: Env;
  let analyticsEngine: ReturnType<typeof createMockAnalyticsEngine>;

  beforeEach(() => {
    analyticsEngine = createMockAnalyticsEngine();
    env = createMockEnv({ ANALYTICS: analyticsEngine });
  });

  describe("processR2EventMessage()", () => {
    it("logs and tracks PutObject events in Analytics Engine", async () => {
      const message = createR2EventMessage();

      await processR2EventMessage(message, env);

      expect(analyticsEngine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (analyticsEngine.writeDataPoint as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(call.blobs).toContain("r2_event");
      expect(call.blobs).toContain("PutObject");
      expect(call.blobs).toContain(
        "exports/markdown-obsidian-2026-03-06.md"
      );
      expect(call.doubles).toContain(4096);
    });

    it("tracks CopyObject events", async () => {
      const message = createR2EventMessage({
        action: "CopyObject",
        object: { key: "exports/copy.json", size: 2048, eTag: "def456" },
      });

      await processR2EventMessage(message, env);

      expect(analyticsEngine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (analyticsEngine.writeDataPoint as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(call.blobs).toContain("CopyObject");
      expect(call.blobs).toContain("exports/copy.json");
    });

    it("tracks CompleteMultipartUpload events", async () => {
      const message = createR2EventMessage({
        action: "CompleteMultipartUpload",
        object: {
          key: "exports/large-export.json",
          size: 1048576,
          eTag: "ghi789",
        },
      });

      await processR2EventMessage(message, env);

      expect(analyticsEngine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (analyticsEngine.writeDataPoint as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(call.blobs).toContain("CompleteMultipartUpload");
      expect(call.doubles).toContain(1048576);
    });

    it("logs event metadata to console", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const message = createR2EventMessage();

      await processR2EventMessage(message, env);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("R2 event: PutObject")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("cortex-storage/exports/markdown-obsidian-2026-03-06.md")
      );

      consoleSpy.mockRestore();
    });
  });

  describe("isR2EventMessage()", () => {
    it("returns true for valid R2 event messages", () => {
      const message = createR2EventMessage();
      expect(isR2EventMessage(message)).toBe(true);
    });

    it("returns false for null", () => {
      expect(isR2EventMessage(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isR2EventMessage(undefined)).toBe(false);
    });

    it("returns false for non-object types", () => {
      expect(isR2EventMessage("string")).toBe(false);
      expect(isR2EventMessage(42)).toBe(false);
      expect(isR2EventMessage(true)).toBe(false);
    });

    it("returns false for crawl messages", () => {
      const crawlMessage = {
        type: "crawl",
        watchItem: { id: 1, url: "https://example.com" },
      };
      expect(isR2EventMessage(crawlMessage)).toBe(false);
    });

    it("returns false for consolidation messages", () => {
      const consolidationMessage = {
        type: "consolidate",
        userMessage: "hello",
        assistantMessage: "world",
        sessionId: "sess-1",
      };
      expect(isR2EventMessage(consolidationMessage)).toBe(false);
    });

    it("returns false when missing account field", () => {
      const message = createR2EventMessage();
      const { account, ...incomplete } = message;
      expect(isR2EventMessage(incomplete)).toBe(false);
    });

    it("returns false when missing bucket field", () => {
      const message = createR2EventMessage();
      const { bucket, ...incomplete } = message;
      expect(isR2EventMessage(incomplete)).toBe(false);
    });

    it("returns false when missing action field", () => {
      const message = createR2EventMessage();
      const { action, ...incomplete } = message;
      expect(isR2EventMessage(incomplete)).toBe(false);
    });

    it("returns false when missing eventTime field", () => {
      const message = createR2EventMessage();
      const { eventTime, ...incomplete } = message;
      expect(isR2EventMessage(incomplete)).toBe(false);
    });

    it("returns false when object is missing", () => {
      const message = createR2EventMessage();
      const { object, ...incomplete } = message;
      expect(isR2EventMessage(incomplete)).toBe(false);
    });

    it("returns false when object.key is missing", () => {
      const message = {
        account: "test",
        bucket: "test",
        action: "PutObject",
        eventTime: "2026-01-01T00:00:00Z",
        object: { size: 100, eTag: "abc" },
      };
      expect(isR2EventMessage(message)).toBe(false);
    });
  });
});
