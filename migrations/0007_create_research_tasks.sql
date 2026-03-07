-- Research tasks — recurring research topics scheduled at various frequencies
CREATE TABLE IF NOT EXISTS research_tasks (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK(frequency IN ('daily', 'weekly', 'biweekly', 'monthly')),
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  sources TEXT,  -- JSON array of seed URLs or search queries
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_tasks_active ON research_tasks(active);
CREATE INDEX IF NOT EXISTS idx_research_tasks_next_run ON research_tasks(next_run_at);

-- Research results — outputs from each research task run
CREATE TABLE IF NOT EXISTS research_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  memories_created TEXT,  -- JSON array of memory IDs
  run_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES research_tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_research_results_task ON research_results(task_id);
CREATE INDEX IF NOT EXISTS idx_research_results_run ON research_results(run_at);
