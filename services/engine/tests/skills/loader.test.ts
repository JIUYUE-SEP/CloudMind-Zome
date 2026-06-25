import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadSkills } from "../../src/skills/loader.js";

describe("loadSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-test-"));
    await fs.mkdir(path.join(tmpDir, "core"));
    await fs.writeFile(
      path.join(tmpDir, "core", "SKILL.md"),
      "Name: core\nDescription: fundamental tools\nVersion: 1.0.0\n"
    );
  });

  it("loads skill manifest from directory", async () => {
    const skills = await loadSkills({ builtinDirs: [tmpDir] });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("core");
    expect(skills[0].description).toBe("fundamental tools");
  });
});
