import { useState, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RoostEngine } from "@roost/core";
import type { ApprovalDecision, Command, Event, Thread } from "@roost/contracts";

const ROLE_COLOR: Record<string, string> = {
  user: "cyan",
  assistant: "white",
  tool: "gray",
  system: "yellow",
};

const execFileAsync = promisify(execFile);

function diffLineColor(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "cyan";
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("@@") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity")
  ) {
    return "cyan";
  }
  return undefined;
}

async function fetchDiff(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const trimmed = stdout.replace(/\s+$/, "");
    return trimmed === "" ? ["(clean working tree)"] : trimmed.split("\n");
  } catch (err) {
    return [`(diff unavailable: ${err instanceof Error ? err.message : String(err)})`];
  }
}

export interface ChatAppProps {
  engine: RoostEngine;
  threadId: string;
  initialPrompt?: string;
}

export function ChatApp({ engine, threadId, initialPrompt }: ChatAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [thread, setThread] = useState<Thread | undefined>(() =>
    engine.getReadModel().threads.find((t) => t.threadId === threadId),
  );
  const [streaming, setStreaming] = useState("");
  const [approval, setApproval] = useState<{ requestId: string; summary: string } | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [diffLines, setDiffLines] = useState<string[]>([]);
  const [diffScroll, setDiffScroll] = useState(0);

  const worktreePath = (() => {
    const rm = engine.getReadModel();
    const t = rm.threads.find((x) => x.threadId === threadId);
    const w = t && rm.worktrees.find((x) => x.worktreeId === t.worktreeId);
    return w?.path;
  })();

  function dispatch(command: Command): void {
    engine.dispatch(command).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }

  function submit(prompt: string): void {
    setInput("");
    setError(null);
    dispatch({
      type: "thread.turn.start",
      threadId,
      turnId: randomUUID(),
      prompt,
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }

  function respond(decision: ApprovalDecision): void {
    if (!approval) return;
    const requestId = approval.requestId;
    setApproval(null);
    dispatch({
      type: "thread.approval.respond",
      threadId,
      requestId,
      decision,
      commandId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
  }

  function interrupt(): void {
    if (thread?.currentTurnId) {
      dispatch({
        type: "thread.turn.interrupt",
        threadId,
        turnId: thread.currentTurnId,
        commandId: randomUUID(),
        createdAt: new Date().toISOString(),
      });
    }
  }

  useEffect(() => {
    const handler = (event: Event) => {
      if (event.aggregateId !== threadId) return;
      const t = engine.getReadModel().threads.find((x) => x.threadId === threadId);
      setThread(t);
      switch (event.type) {
        case "thread.message.delta":
          setStreaming((s) => s + event.payload.delta);
          break;
        case "thread.message.appended":
          if (event.payload.message.role === "assistant") setStreaming("");
          break;
        case "thread.approval.requested":
          setApproval({ requestId: event.payload.requestId, summary: event.payload.summary });
          break;
        case "thread.turn.completed":
        case "thread.turn.failed":
          setStreaming("");
          setApproval(null);
          break;
      }
    };
    engine.on("event", handler);
    return () => {
      engine.off("event", handler);
    };
  }, [engine, threadId]);

  useEffect(() => {
    if (initialPrompt) submit(initialPrompt);
  }, []);

  useEffect(() => {
    if (!showDiff || !worktreePath) return;
    let disposed = false;
    const refresh = async () => {
      const lines = await fetchDiff(worktreePath);
      if (!disposed) setDiffLines(lines);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [showDiff, worktreePath]);

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === "c") {
      if (thread?.currentTurnId) interrupt();
      else exit();
      return;
    }
    if (approval) {
      if (inputStr === "y") respond("allow");
      else if (inputStr === "n") respond("deny");
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (showDiff) {
        setDiffScroll((s) => (key.upArrow ? Math.max(0, s - 1) : s + 1));
      }
      return;
    }
    if (inputStr === "d" && input === "") {
      setShowDiff((v) => !v);
      setDiffScroll(0);
      return;
    }
    if (key.return) {
      if (input.trim()) submit(input.trim());
      return;
    }
    if (key.backspace) {
      setInput((i) => i.slice(0, -1));
      return;
    }
    if (inputStr && !key.ctrl && !key.meta && inputStr.length === 1) {
      setInput((i) => i + inputStr);
    }
  });

  if (!thread) {
    return (
      <Box>
        <Text color="red">unknown thread: {threadId}</Text>
      </Box>
    );
  }

  const status = thread.session.status;
  const statusColor = status === "error" ? "red" : status === "awaiting-approval" ? "yellow" : "green";

  const viewport = Math.max(5, (stdout.rows ?? 24) - 15);
  const clampedScroll = Math.min(diffScroll, Math.max(0, diffLines.length - viewport));
  const visibleDiff = diffLines.slice(clampedScroll, clampedScroll + viewport);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>Roost — {thread.title}</Text>
        <Text color={statusColor}>[{status}]</Text>
      </Box>
      <Text dimColor>
        {thread.messages.length} messages · thread {thread.threadId}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {thread.messages.map((m) => (
          <Box key={m.id}>
            <Text color={ROLE_COLOR[m.role] ?? "white"}>
              {m.role === "user" ? "you" : m.role === "assistant" ? "agent" : m.role}
              {" > "}
            </Text>
            <Text>{m.text}</Text>
          </Box>
        ))}
        {streaming ? (
          <Box>
            <Text color="white">agent</Text>
            <Text color="white">{" > "}</Text>
            <Text color="white">▌{streaming}</Text>
          </Box>
        ) : null}
      </Box>
      {showDiff ? (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginBottom={1}>
          <Text bold color="blue">
            diff — {worktreePath ?? "unknown worktree"}
          </Text>
          {visibleDiff.map((line, i) => (
            <Text key={`${clampedScroll + i}`} color={diffLineColor(line)}>
              {line === "" ? " " : line}
            </Text>
          ))}
          <Text dimColor>
            {diffLines.length > viewport
              ? `…${clampedScroll}/${Math.max(0, diffLines.length - viewport)} · ↑/↓ scroll · d close`
              : "d close"}
          </Text>
        </Box>
      ) : null}
      {approval ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
          <Text color="yellow" bold>
            ⚠ approval: {approval.summary}
          </Text>
          <Text>  (y) allow  (n) deny</Text>
        </Box>
      ) : null}
      {error ? <Text color="red">error: {error}</Text> : null}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{input}</Text>
        <Text dimColor>▌</Text>
      </Box>
      <Text dimColor>Enter to send · Ctrl+C to {thread.currentTurnId ? "interrupt" : "quit"} · d diff</Text>
    </Box>
  );
}
