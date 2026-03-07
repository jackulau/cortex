/**
 * R2 Event Handler — processes R2 event notification messages from R2_EVENT_QUEUE.
 * Handles object-create events from the cortex-storage bucket, logging metadata
 * and tracking events in Analytics Engine.
 *
 * Errors propagate to let the Queue retry automatically.
 */
import type { Env } from "@/shared/types";
import { CortexAnalytics } from "@/observability/analytics";

/**
 * R2 event notification message shape as delivered by Cloudflare R2.
 * @see https://developers.cloudflare.com/r2/buckets/event-notifications/
 */
export interface R2EventMessage {
  account: string;
  bucket: string;
  object: {
    key: string;
    size: number;
    eTag: string;
  };
  action: "PutObject" | "CopyObject" | "CompleteMultipartUpload" | "DeleteObject";
  eventTime: string;
}

/**
 * Process a single R2 event notification message.
 * Logs the event metadata and records it in Analytics Engine.
 */
export async function processR2EventMessage(
  message: R2EventMessage,
  env: Env
): Promise<void> {
  const { object, action, bucket, eventTime } = message;

  console.log(
    `R2 event: ${action} on ${bucket}/${object.key} (${object.size} bytes) at ${eventTime}`
  );

  // Track the event in Analytics Engine
  const analytics = new CortexAnalytics(env.ANALYTICS);
  analytics.trackR2Event(action, object.key, object.size);
}

/**
 * Type guard to check if a queue message body is an R2 event notification.
 * R2 event messages have a specific shape with account, bucket, object, and action fields.
 */
export function isR2EventMessage(body: unknown): body is R2EventMessage {
  if (typeof body !== "object" || body === null) return false;
  const msg = body as Record<string, unknown>;
  return (
    typeof msg.account === "string" &&
    typeof msg.bucket === "string" &&
    typeof msg.action === "string" &&
    typeof msg.eventTime === "string" &&
    typeof msg.object === "object" &&
    msg.object !== null &&
    typeof (msg.object as Record<string, unknown>).key === "string"
  );
}
