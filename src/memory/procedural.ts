import type { ProceduralRule, SqlFn } from "@/shared/types";

/**
 * Procedural memory — user-defined rules and preferences stored in DO SQLite.
 * Rules are injected into the system prompt to shape agent behavior.
 */
export class ProceduralMemory {
  constructor(private sql: SqlFn) {}

  /** Add a new rule. */
  add(rule: string, source: "user" | "system" = "user"): number {
    this.sql`INSERT INTO procedural_memory (rule, source) VALUES (${rule}, ${source})`;
    const result = this.sql<{ id: number }>`SELECT last_insert_rowid() as id`;
    return result[0].id;
  }

  /** Get all active rules. */
  getActive(): ProceduralRule[] {
    return this.sql<ProceduralRule>`
      SELECT id, rule, source, active, created_at as createdAt
      FROM procedural_memory WHERE active = 1 ORDER BY created_at`;
  }

  /** Get all rules (including inactive). */
  getAll(): ProceduralRule[] {
    return this.sql<ProceduralRule>`
      SELECT id, rule, source, active, created_at as createdAt
      FROM procedural_memory ORDER BY created_at`;
  }

  /** Deactivate a rule (soft delete). */
  deactivate(id: number): boolean {
    this.sql`UPDATE procedural_memory SET active = 0 WHERE id = ${id}`;
    return true;
  }

  /** Update a rule's text. */
  update(id: number, rule: string): boolean {
    this.sql`UPDATE procedural_memory SET rule = ${rule} WHERE id = ${id}`;
    return true;
  }

  /** Delete a rule permanently. */
  delete(id: number): boolean {
    this.sql`DELETE FROM procedural_memory WHERE id = ${id}`;
    return true;
  }

  /** Format active rules for system prompt injection. */
  toPromptString(): string {
    const rules = this.getActive();
    if (rules.length === 0) return "";
    return (
      "## User Rules & Preferences\n" +
      rules.map((r) => `- ${r.rule}`).join("\n")
    );
  }
}
