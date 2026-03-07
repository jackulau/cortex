import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ResearchScheduler,
  computeNextRun,
  runResearchTask,
  processDueResearchTasks,
  type ResearchTask,
} from "./scheduler";

// ── computeNextRun Tests ──────────────────────────────────────

describe("computeNextRun", () => {
  const baseDate = new Date("2024-06-15T12:00:00Z");

  it("computes daily next run (1 day ahead)", () => {
    const result = computeNextRun("daily", baseDate);
    expect(result).toBe("2024-06-16 12:00:00");
  });

  it("computes weekly next run (7 days ahead)", () => {
    const result = computeNextRun("weekly", baseDate);
    expect(result).toBe("2024-06-22 12:00:00");
  });

  it("computes biweekly next run (14 days ahead)", () => {
    const result = computeNextRun("biweekly", baseDate);
    expect(result).toBe("2024-06-29 12:00:00");
  });

  it("computes monthly next run (1 month ahead)", () => {
    const result = computeNextRun("monthly", baseDate);
    expect(result).toBe("2024-07-15 12:00:00");
  });

  it("defaults to current time when no date provided", () => {
    const result = computeNextRun("daily");
    // Should be a valid date string
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

// ── Mock D1 Database ──────────────────────────────────────────

function createMockDB() {
  const rows: Record<string, any>[] = [];
  let lastBindArgs: any[] = [];

  const mockStatement = {
    bind: vi.fn((...args: any[]) => {
      lastBindArgs = args;
      return mockStatement;
    }),
    run: vi.fn(async () => ({
      meta: { changes: 1 },
    })),
    first: vi.fn(async <T>(): Promise<T | null> => {
      const id = lastBindArgs[0];
      const found = rows.find((r) => r.id === id);
      return (found as T) ?? null;
    }),
    all: vi.fn(async <T>() => {
      return { results: rows as T[] };
    }),
  };

  const db = {
    prepare: vi.fn(() => mockStatement),
    batch: vi.fn(async () => []),
    _rows: rows,
    _statement: mockStatement,
    _getLastBindArgs: () => lastBindArgs,
  } as unknown as D1Database & {
    _rows: Record<string, any>[];
    _statement: typeof mockStatement;
    _getLastBindArgs: () => any[];
  };

  return db;
}

// ── ResearchScheduler Tests ───────────────────────────────────

describe("ResearchScheduler", () => {
  let db: ReturnType<typeof createMockDB>;
  let scheduler: ResearchScheduler;

  beforeEach(() => {
    db = createMockDB();
    scheduler = new ResearchScheduler(db as unknown as D1Database);
  });

  describe("create", () => {
    it("inserts a new research task with default frequency", async () => {
      const id = await scheduler.create({ topic: "AI safety developments" });

      expect(id).toBeTruthy();
      expect(id.length).toBe(36); // UUID format
      expect(db.prepare).toHaveBeenCalled();
      expect(db._statement.bind).toHaveBeenCalledWith(
        expect.any(String), // id
        "AI safety developments", // topic
        "weekly", // default frequency
        expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/), // next_run_at
        null // sources
      );
      expect(db._statement.run).toHaveBeenCalled();
    });

    it("inserts with custom frequency and sources", async () => {
      const id = await scheduler.create({
        topic: "Quantum computing",
        frequency: "monthly",
        sources: ["https://arxiv.org", "quantum computing news"],
      });

      expect(id).toBeTruthy();
      expect(db._statement.bind).toHaveBeenCalledWith(
        expect.any(String),
        "Quantum computing",
        "monthly",
        expect.any(String),
        JSON.stringify(["https://arxiv.org", "quantum computing news"])
      );
    });
  });

  describe("get", () => {
    it("returns null when task not found", async () => {
      const result = await scheduler.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns the task when found", async () => {
      db._rows.push({
        id: "test-id",
        topic: "AI safety",
        frequency: "weekly",
        last_run_at: null,
        next_run_at: "2024-06-22 12:00:00",
        sources: JSON.stringify(["https://example.com"]),
        active: 1,
        created_at: "2024-06-15 12:00:00",
      });

      // Override first to find by the id
      db._statement.first = vi.fn(async () => db._rows[0]);

      const result = await scheduler.get("test-id");
      expect(result).toEqual({
        id: "test-id",
        topic: "AI safety",
        frequency: "weekly",
        lastRunAt: null,
        nextRunAt: "2024-06-22 12:00:00",
        sources: ["https://example.com"],
        active: true,
        createdAt: "2024-06-15 12:00:00",
      });
    });
  });

  describe("list", () => {
    it("lists active tasks", async () => {
      db._rows.push(
        {
          id: "task-1",
          topic: "AI safety",
          frequency: "weekly",
          last_run_at: null,
          next_run_at: "2024-06-22 12:00:00",
          sources: null,
          active: 1,
          created_at: "2024-06-15 12:00:00",
        },
        {
          id: "task-2",
          topic: "Climate change",
          frequency: "daily",
          last_run_at: "2024-06-14 12:00:00",
          next_run_at: "2024-06-16 12:00:00",
          sources: null,
          active: 1,
          created_at: "2024-06-14 12:00:00",
        }
      );

      const tasks = await scheduler.list(true);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].topic).toBe("AI safety");
      expect(tasks[1].topic).toBe("Climate change");
      expect(tasks[1].lastRunAt).toBe("2024-06-14 12:00:00");
    });
  });

  describe("cancel", () => {
    it("deactivates a task and returns true", async () => {
      const cancelled = await scheduler.cancel("task-1");
      expect(cancelled).toBe(true);
      expect(db._statement.bind).toHaveBeenCalledWith("task-1");
    });

    it("returns false when no rows changed", async () => {
      db._statement.run = vi.fn(async () => ({
        meta: { changes: 0 },
      }));

      const cancelled = await scheduler.cancel("nonexistent");
      expect(cancelled).toBe(false);
    });
  });

  describe("getDueTasks", () => {
    it("returns tasks where next_run_at <= now", async () => {
      db._rows.push({
        id: "due-task",
        topic: "Due topic",
        frequency: "daily",
        last_run_at: null,
        next_run_at: "2020-01-01 00:00:00",
        sources: null,
        active: 1,
        created_at: "2020-01-01 00:00:00",
      });

      const tasks = await scheduler.getDueTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("due-task");
    });
  });

  describe("scheduleNextRun", () => {
    it("updates last_run_at and next_run_at", async () => {
      // Setup the get to return a task
      db._statement.first = vi.fn(async () => ({
        id: "task-1",
        topic: "Test",
        frequency: "weekly",
        last_run_at: null,
        next_run_at: "2024-06-22 12:00:00",
        sources: null,
        active: 1,
        created_at: "2024-06-15 12:00:00",
      }));

      await scheduler.scheduleNextRun("task-1");

      // Should have been called twice: first for get(), then for update
      expect(db.prepare).toHaveBeenCalledTimes(2);
      expect(db._statement.run).toHaveBeenCalled();
    });
  });

  describe("storeResult", () => {
    it("inserts a research result", async () => {
      const id = await scheduler.storeResult({
        taskId: "task-1",
        summary: "Key findings about AI safety...",
        memoriesCreated: ["mem-1", "mem-2"],
      });

      expect(id).toBeTruthy();
      expect(db._statement.bind).toHaveBeenCalledWith(
        expect.any(String),
        "task-1",
        "Key findings about AI safety...",
        JSON.stringify(["mem-1", "mem-2"])
      );
    });
  });

  describe("getResults", () => {
    it("returns results for a task", async () => {
      db._rows.push({
        id: "result-1",
        task_id: "task-1",
        summary: "Summary from run 1",
        memories_created: JSON.stringify(["mem-1"]),
        run_at: "2024-06-15 12:00:00",
      });

      const results = await scheduler.getResults("task-1");
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: "result-1",
        taskId: "task-1",
        summary: "Summary from run 1",
        memoriesCreated: ["mem-1"],
        runAt: "2024-06-15 12:00:00",
      });
    });
  });

  describe("getRecentResults", () => {
    it("returns recent results across all tasks", async () => {
      db._rows.push(
        {
          id: "result-1",
          task_id: "task-1",
          summary: "Summary 1",
          memories_created: null,
          run_at: "2024-06-15 12:00:00",
        },
        {
          id: "result-2",
          task_id: "task-2",
          summary: "Summary 2",
          memories_created: JSON.stringify(["mem-1"]),
          run_at: "2024-06-16 12:00:00",
        }
      );

      const results = await scheduler.getRecentResults(10);
      expect(results).toHaveLength(2);
      expect(results[0].memoriesCreated).toBeNull();
      expect(results[1].memoriesCreated).toEqual(["mem-1"]);
    });
  });
});

// ── runResearchTask Tests ─────────────────────────────────────

describe("runResearchTask", () => {
  function createMockAI() {
    return {
      run: vi.fn(async () => ({
        response: "AI-generated research summary about the topic.",
      })),
    } as unknown as Ai;
  }

  function createMockSemanticMemory() {
    return {
      write: vi.fn(async () => "mem-id-123"),
      search: vi.fn(async () => []),
    } as any;
  }

  function createMockScheduler() {
    return {
      storeResult: vi.fn(async () => "result-id-123"),
      scheduleNextRun: vi.fn(async () => {}),
    } as unknown as ResearchScheduler;
  }

  const mockTask: ResearchTask = {
    id: "task-1",
    topic: "AI safety developments",
    frequency: "weekly",
    lastRunAt: null,
    nextRunAt: "2024-06-22 12:00:00",
    sources: ["https://arxiv.org"],
    active: true,
    createdAt: "2024-06-15 12:00:00",
  };

  it("runs a research task and stores results", async () => {
    const ai = createMockAI();
    const semanticMemory = createMockSemanticMemory();
    const scheduler = createMockScheduler();

    const result = await runResearchTask(mockTask, {
      scheduler,
      semanticMemory,
      ai,
      chatModel: "test-model",
    });

    expect(result.taskId).toBe("task-1");
    expect(result.summary).toBe(
      "AI-generated research summary about the topic."
    );
    expect(result.memoriesCreated).toContain("mem-id-123");

    // Should call AI with the topic and sources
    expect(ai.run).toHaveBeenCalledOnce();

    // Should write to semantic memory
    expect(semanticMemory.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "note",
        source: "research",
        tags: expect.arrayContaining(["research", "scheduled"]),
      })
    );

    // Should store the result
    expect(scheduler.storeResult).toHaveBeenCalledWith({
      taskId: "task-1",
      summary: "AI-generated research summary about the topic.",
      memoriesCreated: ["mem-id-123"],
    });

    // Should schedule next run
    expect(scheduler.scheduleNextRun).toHaveBeenCalledWith("task-1");
  });

  it("handles task without sources", async () => {
    const taskWithoutSources: ResearchTask = {
      ...mockTask,
      sources: null,
    };
    const ai = createMockAI();
    const semanticMemory = createMockSemanticMemory();
    const scheduler = createMockScheduler();

    const result = await runResearchTask(taskWithoutSources, {
      scheduler,
      semanticMemory,
      ai,
      chatModel: "test-model",
    });

    expect(result.taskId).toBe("task-1");
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("handles duplicate memory (write returns null)", async () => {
    const ai = createMockAI();
    const semanticMemory = createMockSemanticMemory();
    semanticMemory.write = vi.fn(async () => null);
    const scheduler = createMockScheduler();

    const result = await runResearchTask(mockTask, {
      scheduler,
      semanticMemory,
      ai,
      chatModel: "test-model",
    });

    expect(result.memoriesCreated).toEqual([]);
    expect(scheduler.storeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        memoriesCreated: [],
      })
    );
  });
});

// ── processDueResearchTasks Tests ─────────────────────────────

describe("processDueResearchTasks", () => {
  it("processes due tasks and returns counts", async () => {
    const db = createMockDB();

    // Setup due tasks
    db._rows.push({
      id: "due-task-1",
      topic: "AI safety",
      frequency: "weekly",
      last_run_at: null,
      next_run_at: "2020-01-01 00:00:00",
      sources: null,
      active: 1,
      created_at: "2020-01-01 00:00:00",
    });

    // Mock the first() call for get()
    db._statement.first = vi.fn(async () => db._rows[0]);

    const mockAI = {
      run: vi.fn(async () => ({
        response: "Research findings.",
      })),
    } as unknown as Ai;

    const mockSemanticMemory = {
      write: vi.fn(async () => "mem-id"),
      search: vi.fn(async () => []),
    } as any;

    const result = await processDueResearchTasks({
      db: db as unknown as D1Database,
      semanticMemory: mockSemanticMemory,
      ai: mockAI,
      chatModel: "test-model",
    });

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("returns zero counts when no tasks are due", async () => {
    const db = createMockDB();
    // No rows — no due tasks

    const mockAI = {
      run: vi.fn(),
    } as unknown as Ai;

    const mockSemanticMemory = {
      write: vi.fn(),
      search: vi.fn(async () => []),
    } as any;

    const result = await processDueResearchTasks({
      db: db as unknown as D1Database,
      semanticMemory: mockSemanticMemory,
      ai: mockAI,
      chatModel: "test-model",
    });

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockAI.run).not.toHaveBeenCalled();
  });

  it("counts errors and continues processing", async () => {
    const db = createMockDB();

    db._rows.push(
      {
        id: "task-fail",
        topic: "Failing task",
        frequency: "daily",
        last_run_at: null,
        next_run_at: "2020-01-01 00:00:00",
        sources: null,
        active: 1,
        created_at: "2020-01-01 00:00:00",
      },
      {
        id: "task-ok",
        topic: "OK task",
        frequency: "daily",
        last_run_at: null,
        next_run_at: "2020-01-01 00:00:00",
        sources: null,
        active: 1,
        created_at: "2020-01-01 00:00:00",
      }
    );

    let callCount = 0;
    db._statement.first = vi.fn(async () => {
      callCount++;
      return db._rows[callCount <= 2 ? 0 : 1];
    });

    const mockAI = {
      run: vi.fn(async (_model: any, opts: any) => {
        // Fail for first task based on prompt content
        const content = opts.messages?.[1]?.content || "";
        if (content.includes("Failing task")) {
          throw new Error("AI service unavailable");
        }
        return { response: "Success." };
      }),
    } as unknown as Ai;

    const mockSemanticMemory = {
      write: vi.fn(async () => "mem-id"),
      search: vi.fn(async () => []),
    } as any;

    const result = await processDueResearchTasks({
      db: db as unknown as D1Database,
      semanticMemory: mockSemanticMemory,
      ai: mockAI,
      chatModel: "test-model",
    });

    expect(result.errors).toBe(1);
    expect(result.processed).toBe(1);
  });
});
