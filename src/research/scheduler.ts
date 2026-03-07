/**
 * Research Scheduler — manages recurring research tasks stored in D1.
 *
 * Provides CRUD for research tasks and handles the execution of due tasks
 * using the agentic research loop to gather, synthesize, and store findings.
 */

import type { SemanticMemory } from "@/memory/semantic";

// ── Types ─────────────────────────────────────────────────────

export type ResearchFrequency = "daily" | "weekly" | "biweekly" | "monthly";

export interface ResearchTask {
  id: string;
  topic: string;
  frequency: ResearchFrequency;
  lastRunAt: string | null;
  nextRunAt: string;
  sources: string[] | null;
  active: boolean;
  createdAt: string;
}

export interface ResearchResult {
  id: string;
  taskId: string;
  summary: string;
  memoriesCreated: string[] | null;
  runAt: string;
}

/** Raw row shape from D1 (snake_case columns). */
interface RawTaskRow {
  id: string;
  topic: string;
  frequency: string;
  last_run_at: string | null;
  next_run_at: string;
  sources: string | null;
  active: number;
  created_at: string;
}

interface RawResultRow {
  id: string;
  task_id: string;
  summary: string;
  memories_created: string | null;
  run_at: string;
}

// ── Row Converters ────────────────────────────────────────────

function rowToTask(row: RawTaskRow): ResearchTask {
  return {
    id: row.id,
    topic: row.topic,
    frequency: row.frequency as ResearchFrequency,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    sources: row.sources ? JSON.parse(row.sources) : null,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

function rowToResult(row: RawResultRow): ResearchResult {
  return {
    id: row.id,
    taskId: row.task_id,
    summary: row.summary,
    memoriesCreated: row.memories_created
      ? JSON.parse(row.memories_created)
      : null,
    runAt: row.run_at,
  };
}

// ── Scheduling Helpers ────────────────────────────────────────

/**
 * Compute the next run timestamp based on the given frequency, starting from `from`.
 */
export function computeNextRun(
  frequency: ResearchFrequency,
  from: Date = new Date()
): string {
  const next = new Date(from.getTime());
  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case "biweekly":
      next.setUTCDate(next.getUTCDate() + 14);
      break;
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + 1);
      break;
  }
  return next.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// ── Research Task Manager ─────────────────────────────────────

export class ResearchScheduler {
  constructor(private db: D1Database) {}

  /** Create a new research task. Returns the generated ID. */
  async create(task: {
    topic: string;
    frequency?: ResearchFrequency;
    sources?: string[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    const frequency = task.frequency ?? "weekly";
    const nextRunAt = computeNextRun(frequency);
    const sources = task.sources ? JSON.stringify(task.sources) : null;

    await this.db
      .prepare(
        `INSERT INTO research_tasks (id, topic, frequency, next_run_at, sources)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, task.topic, frequency, nextRunAt, sources)
      .run();

    return id;
  }

  /** Get a single research task by ID. */
  async get(id: string): Promise<ResearchTask | null> {
    const row = await this.db
      .prepare(`SELECT * FROM research_tasks WHERE id = ?`)
      .bind(id)
      .first<RawTaskRow>();
    if (!row) return null;
    return rowToTask(row);
  }

  /** List all research tasks, optionally filtering to active only. */
  async list(activeOnly = true): Promise<ResearchTask[]> {
    let sql = `SELECT * FROM research_tasks`;
    if (activeOnly) {
      sql += ` WHERE active = 1`;
    }
    sql += ` ORDER BY created_at DESC`;

    const { results } = await this.db.prepare(sql).all<RawTaskRow>();
    return (results ?? []).map(rowToTask);
  }

  /** Deactivate a research task. Returns true if a row was updated. */
  async cancel(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE research_tasks SET active = 0 WHERE id = ?`)
      .bind(id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Get tasks that are due to run (next_run_at <= now and active). */
  async getDueTasks(): Promise<ResearchTask[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM research_tasks
         WHERE active = 1 AND next_run_at <= datetime('now')
         ORDER BY next_run_at ASC`
      )
      .all<RawTaskRow>();
    return (results ?? []).map(rowToTask);
  }

  /** Update last_run_at and compute next_run_at after a task completes. */
  async scheduleNextRun(taskId: string): Promise<void> {
    const task = await this.get(taskId);
    if (!task) return;

    const now = new Date();
    const lastRunAt = now.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    const nextRunAt = computeNextRun(task.frequency, now);

    await this.db
      .prepare(
        `UPDATE research_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?`
      )
      .bind(lastRunAt, nextRunAt, taskId)
      .run();
  }

  /** Store a research result. */
  async storeResult(result: {
    taskId: string;
    summary: string;
    memoriesCreated: string[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    const memoriesJson = JSON.stringify(result.memoriesCreated);

    await this.db
      .prepare(
        `INSERT INTO research_results (id, task_id, summary, memories_created)
         VALUES (?, ?, ?, ?)`
      )
      .bind(id, result.taskId, result.summary, memoriesJson)
      .run();

    return id;
  }

  /** Get recent results for a task, ordered by run time (newest first). */
  async getResults(
    taskId: string,
    limit = 5
  ): Promise<ResearchResult[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM research_results WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`
      )
      .bind(taskId, limit)
      .all<RawResultRow>();
    return (results ?? []).map(rowToResult);
  }

  /** Get all recent results across all tasks. */
  async getRecentResults(limit = 10): Promise<ResearchResult[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM research_results ORDER BY run_at DESC LIMIT ?`
      )
      .bind(limit)
      .all<RawResultRow>();
    return (results ?? []).map(rowToResult);
  }
}

// ── Research Task Execution ───────────────────────────────────

/**
 * Run a single research task: construct a prompt from the topic and seed sources,
 * use AI to synthesize findings, and store results as semantic memories.
 */
export async function runResearchTask(
  task: ResearchTask,
  deps: {
    scheduler: ResearchScheduler;
    semanticMemory: SemanticMemory;
    ai: Ai;
    chatModel: string;
  }
): Promise<ResearchResult> {
  const { scheduler, semanticMemory, ai, chatModel } = deps;

  // Build the research prompt
  const sourcesContext = task.sources?.length
    ? `\n\nSeed sources/queries to consider:\n${task.sources.map((s) => `- ${s}`).join("\n")}`
    : "";

  const prompt = `Research the following topic and provide a comprehensive, up-to-date summary of recent developments, key findings, and important trends.

Topic: ${task.topic}${sourcesContext}

Provide a well-structured summary covering:
1. Recent developments and news
2. Key findings or trends
3. Notable opinions or analyses
4. Open questions or areas to watch

Be factual, concise, and cite specific details where possible.`;

  // Use AI to synthesize research findings
  const response = (await ai.run(chatModel as any, {
    messages: [
      {
        role: "system",
        content:
          "You are a research analyst. Synthesize the latest knowledge about the given topic into a clear, informative summary. Focus on what is new, important, and actionable.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_tokens: 1000,
  })) as { response?: string };

  const synthesis = response.response?.trim() || "Unable to generate research synthesis.";

  // Store findings as semantic memories
  const memoryIds: string[] = [];

  // Main synthesis memory
  const mainContent = `Research: ${task.topic}\n\nDate: ${new Date().toISOString().split("T")[0]}\n\n${synthesis}`;
  const mainId = await semanticMemory.write({
    content: mainContent,
    type: "note",
    source: "research",
    tags: [
      "research",
      "scheduled",
      ...task.topic.toLowerCase().split(/\s+/).slice(0, 3),
    ],
  });
  if (mainId) {
    memoryIds.push(mainId);
  }

  // Store the result
  const resultId = await scheduler.storeResult({
    taskId: task.id,
    summary: synthesis,
    memoriesCreated: memoryIds,
  });

  // Schedule the next run
  await scheduler.scheduleNextRun(task.id);

  return {
    id: resultId,
    taskId: task.id,
    summary: synthesis,
    memoriesCreated: memoryIds,
    runAt: new Date().toISOString(),
  };
}

// ── Cron Entry Point ──────────────────────────────────────────

/**
 * Process all due research tasks. Called from the cron handler.
 * Returns the number of tasks processed.
 */
export async function processDueResearchTasks(deps: {
  db: D1Database;
  semanticMemory: SemanticMemory;
  ai: Ai;
  chatModel: string;
}): Promise<{ processed: number; errors: number }> {
  const scheduler = new ResearchScheduler(deps.db);
  const dueTasks = await scheduler.getDueTasks();

  let processed = 0;
  let errors = 0;

  for (const task of dueTasks) {
    try {
      await runResearchTask(task, {
        scheduler,
        semanticMemory: deps.semanticMemory,
        ai: deps.ai,
        chatModel: deps.chatModel,
      });
      processed++;
    } catch (err) {
      console.error(
        `Research task error (${task.id} — ${task.topic}):`,
        err instanceof Error ? err.message : err
      );
      errors++;
      // Still schedule next run so one failure doesn't block future runs
      await scheduler.scheduleNextRun(task.id).catch(() => {});
    }
  }

  return { processed, errors };
}
