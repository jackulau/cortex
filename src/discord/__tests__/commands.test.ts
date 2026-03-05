import { describe, it, expect } from "vitest";
import { COMMANDS, OptionType } from "../commands";

describe("COMMANDS", () => {
  it("defines exactly 5 commands", () => {
    expect(COMMANDS).toHaveLength(5);
  });

  it("includes all required command names", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("ask");
    expect(names).toContain("remember");
    expect(names).toContain("recall");
    expect(names).toContain("research");
    expect(names).toContain("digest");
  });

  describe("/ask command", () => {
    const cmd = COMMANDS.find((c) => c.name === "ask")!;

    it("has a description", () => {
      expect(cmd.description).toBe("Ask Cortex a question");
    });

    it("has a required question option of type STRING", () => {
      expect(cmd.options).toHaveLength(1);
      const opt = cmd.options![0];
      expect(opt.name).toBe("question");
      expect(opt.type).toBe(OptionType.STRING);
      expect(opt.required).toBe(true);
    });
  });

  describe("/remember command", () => {
    const cmd = COMMANDS.find((c) => c.name === "remember")!;

    it("has a description", () => {
      expect(cmd.description).toBe("Save something to Cortex's memory");
    });

    it("has required content option", () => {
      const opt = cmd.options!.find((o) => o.name === "content")!;
      expect(opt.type).toBe(OptionType.STRING);
      expect(opt.required).toBe(true);
    });

    it("has optional type option with choices", () => {
      const opt = cmd.options!.find((o) => o.name === "type")!;
      expect(opt.type).toBe(OptionType.STRING);
      expect(opt.required).toBe(false);
      expect("choices" in opt).toBe(true);
      const choices = (opt as any).choices;
      expect(choices).toHaveLength(4);
      const values = choices.map((c: any) => c.value);
      expect(values).toContain("fact");
      expect(values).toContain("preference");
      expect(values).toContain("event");
      expect(values).toContain("note");
    });
  });

  describe("/recall command", () => {
    const cmd = COMMANDS.find((c) => c.name === "recall")!;

    it("has a description", () => {
      expect(cmd.description).toBe("Search Cortex's memory");
    });

    it("has a required query option of type STRING", () => {
      expect(cmd.options).toHaveLength(1);
      const opt = cmd.options![0];
      expect(opt.name).toBe("query");
      expect(opt.type).toBe(OptionType.STRING);
      expect(opt.required).toBe(true);
    });
  });

  describe("/research command", () => {
    const cmd = COMMANDS.find((c) => c.name === "research")!;

    it("has a description", () => {
      expect(cmd.description).toBe("Research a URL");
    });

    it("has a required url option of type STRING", () => {
      expect(cmd.options).toHaveLength(1);
      const opt = cmd.options![0];
      expect(opt.name).toBe("url");
      expect(opt.type).toBe(OptionType.STRING);
      expect(opt.required).toBe(true);
    });
  });

  describe("/digest command", () => {
    const cmd = COMMANDS.find((c) => c.name === "digest")!;

    it("has a description", () => {
      expect(cmd.description).toBe("Get your latest digest");
    });

    it("has no options", () => {
      expect(cmd).not.toHaveProperty("options");
    });
  });
});
