/**
 * WatchSchedulerDO — Durable Object that manages per-watch-item alarms.
 *
 * Each watch item gets its own DO instance (keyed by item ID).
 * The alarm fires at the item's configured frequency, enqueues the item
 * to CRAWL_QUEUE, and re-schedules the next alarm.
 */
import type { Env } from "@/shared/types";
import type { WatchItem } from "./watchlist";
import type { CrawlMessage } from "./queue-types";

/** Interval in milliseconds for each frequency tier. */
const FREQUENCY_MS: Record<string, number> = {
  hourly: 60 * 60 * 1000, // 1 hour
  daily: 24 * 60 * 60 * 1000, // 24 hours
  weekly: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export class WatchSchedulerDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * HTTP handler — accepts POST requests to schedule or cancel alarms.
   *
   * POST /schedule  — body: WatchItem → schedule alarm for this item
   * POST /cancel    — cancel the current alarm and clear stored data
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (url.pathname === "/schedule") {
      return this.handleSchedule(request);
    }

    if (url.pathname === "/cancel") {
      return this.handleCancel();
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  /**
   * Schedule (or reschedule) an alarm for the given watch item.
   * Stores the item data in DO storage so alarm() can access it.
   */
  private async handleSchedule(request: Request): Promise<Response> {
    const watchItem = (await request.json()) as WatchItem;

    // Store item data for when the alarm fires
    await this.state.storage.put("watchItem", watchItem);

    // Calculate delay based on frequency
    const delayMs = FREQUENCY_MS[watchItem.frequency] ?? FREQUENCY_MS.daily;
    const nextAlarmTime = Date.now() + delayMs;

    // Set the alarm (overwrites any existing alarm)
    await this.state.storage.setAlarm(nextAlarmTime);

    return Response.json({
      success: true,
      nextAlarm: new Date(nextAlarmTime).toISOString(),
    });
  }

  /**
   * Cancel the alarm and clear stored data.
   */
  private async handleCancel(): Promise<Response> {
    await this.state.storage.deleteAlarm();
    await this.state.storage.delete("watchItem");

    return Response.json({ success: true });
  }

  /**
   * Alarm handler — fires when the scheduled time arrives.
   * Enqueues the watch item to CRAWL_QUEUE, then re-schedules.
   */
  async alarm(): Promise<void> {
    const watchItem = await this.state.storage.get<WatchItem>("watchItem");

    if (!watchItem) {
      // No item stored — nothing to do, don't re-schedule
      return;
    }

    // Enqueue the item for crawling
    await this.env.CRAWL_QUEUE.send({
      type: "crawl",
      watchItem,
    } satisfies CrawlMessage);

    // Re-schedule the next alarm
    const delayMs = FREQUENCY_MS[watchItem.frequency] ?? FREQUENCY_MS.daily;
    const nextAlarmTime = Date.now() + delayMs;
    await this.state.storage.setAlarm(nextAlarmTime);
  }
}

// ── Helper ─────────────────────────────────────────────────────

/**
 * Schedule an alarm for a watch item by sending it to the DO instance.
 * Each watch item gets its own DO instance keyed by item ID.
 */
export async function scheduleWatchAlarm(
  env: Env,
  watchItem: WatchItem
): Promise<void> {
  const id = env.WatchScheduler.idFromName(watchItem.id);
  const stub = env.WatchScheduler.get(id);
  await stub.fetch(new Request("https://do/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(watchItem),
  }));
}

/**
 * Cancel the alarm for a watch item.
 */
export async function cancelWatchAlarm(
  env: Env,
  watchItemId: string
): Promise<void> {
  const id = env.WatchScheduler.idFromName(watchItemId);
  const stub = env.WatchScheduler.get(id);
  await stub.fetch(new Request("https://do/cancel", {
    method: "POST",
  }));
}
