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
      "twiboost",
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

  test("routes common Maton Telegram actions through short dedicated tools", async () => {
    registerTelegramMcpSkills();

    const maton = getBundledSkills().find((skill) => skill.name === "maton-api-gateway");
    const blocks = await maton.getPromptForCommand("", {} as never);
    const prompt = blocks[0].text;

    expect(prompt).toContain("maton_telegram_get_me");
    expect(prompt).toContain("maton_telegram_prepare_send_message");
    expect(prompt).toContain("maton_telegram_prepare_send_animation");
    expect(prompt).toContain("Do not assemble a generic");
  });

  test("requires a channel-specific brief and adaptive post length", async () => {
    registerTelegramMcpSkills();

    const telegram = getBundledSkills().find(
      (skill) => skill.name === "telegram-mcp-operations",
    );
    const blocks = await telegram.getPromptForCommand("", {} as never);
    const prompt = blocks[0].text;

    expect(prompt).toContain("content_channel_post_brief");
    expect(prompt).toContain("short");
    expect(prompt).toContain("standard");
    expect(prompt).toContain("long");
    expect(prompt).toContain("Do not impose a universal 350-900 character limit");
  });

  test("requires captured Telegram entities when reusing source posts", async () => {
    registerTelegramMcpSkills();

    const telegram = getBundledSkills().find(
      (skill) => skill.name === "telegram-mcp-operations",
    );
    const blocks = await telegram.getPromptForCommand("", {} as never);
    const prompt = blocks[0].text;

    expect(prompt).toContain("content_capture_source_post");
    expect(prompt).toContain("UTF-16 `entities`");
    expect(prompt).toContain("allow_formatting_loss=true");
  });
});
