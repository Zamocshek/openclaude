// @ts-nocheck
import { afterEach, describe, expect, test } from "bun:test";

import { clearBundledSkills, getBundledSkills } from "../bundledSkills.js";
import { registerTelegramMcpSkills } from "./telegramMcp.js";

afterEach(() => {
  clearBundledSkills();
});

describe("Telegram MCP bundled skills", () => {
  test("registers every required Telegram integration skill", async () => {
    registerTelegramMcpSkills();

    const skills = getBundledSkills();
    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "maton-api-gateway",
      "telegram-mcp-operations",
      "vpromotions",
    ]);
    for (const skill of skills) {
      expect(skill.type).toBe("prompt");
      expect(skill.userInvocable).toBe(true);
      const blocks = await skill.getPromptForCommand("", {} as never);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: "text" });
      expect((blocks[0] as { text: string }).text.length).toBeGreaterThan(250);
    }
  });
});
