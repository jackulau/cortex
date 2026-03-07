import { describe, it, expect, vi } from "vitest";
import { WatchSchedulerDO } from "./watch-scheduler";
import type { WatchItem } from "./watchlist";

// ── Mock helpers ──────────────────────────────────────────────

function createMockWatchItem(
  overrides: Partial<WatchItem> = {}
): WatchItem {
  return {
    id: "item-123",
    url: "https://example.com",
    label: "Example",
    frequency: "daily",
    lastChecked: null,
    lastHash: null,
    active: true,
    createdAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockStorage() {
  const store = new Map<string, unknown>();
  let alarmTime: number | null = null;

  return {
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
      return true;
    }),
    setAlarm: vi.fn(async (time: number) => {
      alarmTime = time;
    }),
    deleteAlarm: vi.fn(async () => {
      alarmTime = null;
    }),
    // Expose internal state for assertions
    _store: store,
    _getAlarmTime: () => alarmTime,
  };
}

function createMockEnv() {
  return {
    CRAWL_QUEUE: {
      send: vi.fn(async () => {}),
    },
    WatchScheduler: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(),
    },
  } as any;
}

function createDO(storage?: ReturnType<typeof createMockStorage>, env?: any) {
  const mockStorage = storage ?? createMockStorage();
  const mockEnv = env ?? createMockEnv();

  const state = {
    storage: mockStorage,
  } as unknown as DurableObjectState;

  return { do: new WatchSchedulerDO(state, mockEnv), storage: mockStorage, env: mockEnv };
}

// ── Tests ─────────────────────────────────────────────────────

describe("WatchSchedulerDO", () => {
  describe("fetch()", () => {
    it("returns 405 for non-POST requests", async () => {
      const { do: scheduler } = createDO();
      const response = await scheduler.fetch(
        new Request("https://do/schedule", { method: "GET" })
      );
      expect(response.status).toBe(405);
      const body = await response.json() as any;
      expect(body.error).toBe("Method not allowed");
    });

    it("returns 404 for unknown paths", async () => {
      const { do: scheduler } = createDO();
      const response = await scheduler.fetch(
        new Request("https://do/unknown", { method: "POST" })
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /schedule", () => {
    it("stores watch item and sets alarm", async () => {
      const { do: scheduler, storage } = createDO();
      const item = createMockWatchItem({ frequency: "hourly" });

      const response = await scheduler.fetch(
        new Request("https://do/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.success).toBe(true);
      expect(body.nextAlarm).toBeDefined();

      // Verify item was stored
      expect(storage.put).toHaveBeenCalledWith("watchItem", item);

      // Verify alarm was set (should be ~1 hour from now for hourly)
      expect(storage.setAlarm).toHaveBeenCalledTimes(1);
      const alarmTime = storage.setAlarm.mock.calls[0][0];
      const oneHourMs = 60 * 60 * 1000;
      expect(alarmTime).toBeGreaterThanOrEqual(Date.now() + oneHourMs - 1000);
      expect(alarmTime).toBeLessThanOrEqual(Date.now() + oneHourMs + 1000);
    });

    it("sets daily alarm for daily frequency", async () => {
      const { do: scheduler, storage } = createDO();
      const item = createMockWatchItem({ frequency: "daily" });

      await scheduler.fetch(
        new Request("https://do/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      );

      const alarmTime = storage.setAlarm.mock.calls[0][0];
      const oneDayMs = 24 * 60 * 60 * 1000;
      expect(alarmTime).toBeGreaterThanOrEqual(Date.now() + oneDayMs - 1000);
      expect(alarmTime).toBeLessThanOrEqual(Date.now() + oneDayMs + 1000);
    });

    it("sets weekly alarm for weekly frequency", async () => {
      const { do: scheduler, storage } = createDO();
      const item = createMockWatchItem({ frequency: "weekly" });

      await scheduler.fetch(
        new Request("https://do/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      );

      const alarmTime = storage.setAlarm.mock.calls[0][0];
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      expect(alarmTime).toBeGreaterThanOrEqual(Date.now() + oneWeekMs - 1000);
      expect(alarmTime).toBeLessThanOrEqual(Date.now() + oneWeekMs + 1000);
    });
  });

  describe("POST /cancel", () => {
    it("deletes alarm and clears stored data", async () => {
      const { do: scheduler, storage } = createDO();

      // First schedule an item
      const item = createMockWatchItem();
      await scheduler.fetch(
        new Request("https://do/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        })
      );

      // Then cancel it
      const response = await scheduler.fetch(
        new Request("https://do/cancel", { method: "POST" })
      );

      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.success).toBe(true);

      // Verify alarm was deleted
      expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);

      // Verify stored item was deleted
      expect(storage.delete).toHaveBeenCalledWith("watchItem");
    });
  });

  describe("alarm()", () => {
    it("enqueues watch item to CRAWL_QUEUE and re-schedules", async () => {
      const storage = createMockStorage();
      const env = createMockEnv();
      const { do: scheduler } = createDO(storage, env);

      // Store a watch item as if it was scheduled
      const item = createMockWatchItem({ frequency: "hourly" });
      storage._store.set("watchItem", item);

      // Fire the alarm
      await scheduler.alarm();

      // Verify item was enqueued
      expect(env.CRAWL_QUEUE.send).toHaveBeenCalledTimes(1);
      expect(env.CRAWL_QUEUE.send).toHaveBeenCalledWith({
        type: "crawl",
        watchItem: item,
      });

      // Verify alarm was re-scheduled
      expect(storage.setAlarm).toHaveBeenCalledTimes(1);
      const alarmTime = storage.setAlarm.mock.calls[0][0];
      const oneHourMs = 60 * 60 * 1000;
      expect(alarmTime).toBeGreaterThanOrEqual(Date.now() + oneHourMs - 1000);
    });

    it("does nothing if no watch item is stored", async () => {
      const storage = createMockStorage();
      const env = createMockEnv();
      const { do: scheduler } = createDO(storage, env);

      // No item stored — alarm fires but nothing happens
      await scheduler.alarm();

      expect(env.CRAWL_QUEUE.send).not.toHaveBeenCalled();
      expect(storage.setAlarm).not.toHaveBeenCalled();
    });

    it("re-schedules with correct interval for daily items", async () => {
      const storage = createMockStorage();
      const env = createMockEnv();
      const { do: scheduler } = createDO(storage, env);

      const item = createMockWatchItem({ frequency: "daily" });
      storage._store.set("watchItem", item);

      await scheduler.alarm();

      const alarmTime = storage.setAlarm.mock.calls[0][0];
      const oneDayMs = 24 * 60 * 60 * 1000;
      expect(alarmTime).toBeGreaterThanOrEqual(Date.now() + oneDayMs - 1000);
      expect(alarmTime).toBeLessThanOrEqual(Date.now() + oneDayMs + 1000);
    });

    it("re-schedules with correct interval for weekly items", async () => {
      const storage = createMockStorage();
      const env = createMockEnv();
      const { do: scheduler } = createDO(storage, env);

      const item = createMockWatchItem({ frequency: "weekly" });
      storage._store.set("watchItem", item);

      await scheduler.alarm();

      const alarmTime = storage.setAlarm.mock.calls[0][0];
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      expect(alarmTime).toBeGreaterThanOrEqual(Date.now() + oneWeekMs - 1000);
      expect(alarmTime).toBeLessThanOrEqual(Date.now() + oneWeekMs + 1000);
    });
  });
});

describe("scheduleWatchAlarm / cancelWatchAlarm helpers", () => {
  it("scheduleWatchAlarm sends POST /schedule to the correct DO instance", async () => {
    // We test the helper functions by importing them directly
    const { scheduleWatchAlarm } = await import("./watch-scheduler");

    const mockFetch = vi.fn(async () => Response.json({ success: true }));
    const mockStub = { fetch: mockFetch };

    const env = {
      WatchScheduler: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => mockStub),
      },
    } as any;

    const item = createMockWatchItem({ id: "test-item-456" });
    await scheduleWatchAlarm(env, item);

    // Verify correct DO instance was looked up
    expect(env.WatchScheduler.idFromName).toHaveBeenCalledWith("test-item-456");
    expect(env.WatchScheduler.get).toHaveBeenCalled();

    // Verify POST /schedule was called with the item as body
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const request = mockFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/schedule");
    const body = await request.json();
    expect(body).toEqual(item);
  });

  it("cancelWatchAlarm sends POST /cancel to the correct DO instance", async () => {
    const { cancelWatchAlarm } = await import("./watch-scheduler");

    const mockFetch = vi.fn(async () => Response.json({ success: true }));
    const mockStub = { fetch: mockFetch };

    const env = {
      WatchScheduler: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => mockStub),
      },
    } as any;

    await cancelWatchAlarm(env, "test-item-789");

    expect(env.WatchScheduler.idFromName).toHaveBeenCalledWith("test-item-789");
    expect(env.WatchScheduler.get).toHaveBeenCalled();

    const request = mockFetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/cancel");
  });
});
