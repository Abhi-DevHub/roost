import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCommandFile,
  expandCommand,
  discoverCommands,
  commandPrompt,
  InvalidCommandError,
} from "../src/index.js";

describe("commands", () => {
  it("parses frontmatter + body", () => {
    const def = parseCommandFile("---\ndescription: say hi\n---\nhello $ARGUMENTS", "/x/say.md", "say");
    expect(def.name).toBe("say");
    expect(def.description).toBe("say hi");
    expect(def.body).toBe("hello $ARGUMENTS");
  });

  it("rejects a file without frontmatter", () => {
    expect(() => parseCommandFile("no frontmatter", "/x/say.md", "say")).toThrow(InvalidCommandError);
  });

  it("expands $ARGUMENTS and $1..$9", () => {
    expect(expandCommand("hi $ARGUMENTS", ["a", "b"])).toBe("hi a b");
    expect(expandCommand("first=$1 second=$2", ["x", "y"])).toBe("first=x second=y");
    expect(expandCommand("missing: [$3]", [])).toBe("missing: []");
    expect(expandCommand("$ARGUMENTS and $1", ["z"])).toBe("z and z");
    expect(expandCommand("$ARGUMENTS", [])).toBe("");
  });

  it("discoverCommands loads *.md files and commandPrompt expands", () => {
    const root = mkdtempSync(join(tmpdir(), "roost-cmds-"));
    const cmdsDir = join(root, "commands");
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(join(cmdsDir, "greet.md"), "---\ndescription: greet someone\n---\nhello $1");
    writeFileSync(join(cmdsDir, "bye.md"), "---\ndescription: say bye\n---\nbye $ARGUMENTS");

    const cmds = discoverCommands(cmdsDir);
    expect(cmds.map((c) => c.name)).toEqual(["bye", "greet"]);
    const greet = cmds.find((c) => c.name === "greet")!;
    expect(commandPrompt(greet, ["bob"])).toBe("hello bob");
    expect(commandPrompt(cmds.find((c) => c.name === "bye")!, ["a", "b"])).toBe("bye a b");

    rmSync(root, { recursive: true, force: true });
  });

  it("discoverCommands returns empty for a missing directory", () => {
    expect(discoverCommands(join(tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });
});
