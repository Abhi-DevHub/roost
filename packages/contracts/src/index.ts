import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string. */
const IsoDate = z.string().min(1);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const ProjectCreateCommandSchema = z.object({
  type: z.literal("project.create"),
  projectId: z.string().min(1),
  title: z.string().min(1),
  workspaceRoot: z.string().min(1),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const WorktreeCreateCommandSchema = z.object({
  type: z.literal("worktree.create"),
  worktreeId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  baseRef: z.string().min(1),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const WorktreeRemoveCommandSchema = z.object({
  type: z.literal("worktree.remove"),
  worktreeId: z.string().min(1),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

// --- threads ----------------------------------------------------------------

export const SessionStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "awaiting-approval",
  "error",
]);

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: MessageRoleSchema,
  text: z.string(),
  at: IsoDate,
});

export const ThreadCreateCommandSchema = z.object({
  type: z.literal("thread.create"),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  title: z.string().min(1),
  /** Execution host route (`local`, `ssh:<id>`, …). Defaults to `local`. */
  hostId: z.string().min(1).optional(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadForkCommandSchema = z.object({
  type: z.literal("thread.fork"),
  threadId: z.string().min(1),
  parentThreadId: z.string().min(1),
  title: z.string().min(1),
  /** Copy the parent's messages up to and including this message id (default: all). */
  upToMessageId: z.string().min(1).optional(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadCompactCommandSchema = z.object({
  type: z.literal("thread.compact"),
  threadId: z.string().min(1),
  /** Replacement message list: a handoff system message followed by the kept messages. */
  messages: z.array(MessageSchema),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadTurnStartCommandSchema = z.object({
  type: z.literal("thread.turn.start"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  prompt: z.string().min(1),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadTurnInterruptCommandSchema = z.object({
  type: z.literal("thread.turn.interrupt"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ApprovalDecisionSchema = z.enum(["allow", "deny"]);

export const ThreadApprovalRespondCommandSchema = z.object({
  type: z.literal("thread.approval.respond"),
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  decision: ApprovalDecisionSchema,
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const GitActionSchema = z.enum(["commit", "push", "createPr"]);

export const ThreadGitActionCommandSchema = z.object({
  type: z.literal("thread.git.action"),
  threadId: z.string().min(1),
  action: GitActionSchema,
  /** Commit message (commit) or PR title (createPr). */
  message: z.string().optional(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

// --- reactor feedback commands (dispatched by reactors, decided like any other) ---

export const ThreadMessageAppendCommandSchema = z.object({
  type: z.literal("thread.message.append"),
  threadId: z.string().min(1),
  message: MessageSchema,
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadMessageStreamCommandSchema = z.object({
  type: z.literal("thread.message.stream"),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  delta: z.string(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadTurnCompleteCommandSchema = z.object({
  type: z.literal("thread.turn.complete"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadTurnFailCommandSchema = z.object({
  type: z.literal("thread.turn.fail"),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  error: z.string(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadSessionSetCommandSchema = z.object({
  type: z.literal("thread.session.set"),
  threadId: z.string().min(1),
  status: SessionStatusSchema,
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadApprovalRequestCommandSchema = z.object({
  type: z.literal("thread.approval.request"),
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  summary: z.string(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadGitCompleteCommandSchema = z.object({
  type: z.literal("thread.git.complete"),
  threadId: z.string().min(1),
  action: GitActionSchema,
  ok: z.boolean(),
  summary: z.string(),
  commandId: z.string().min(1),
  createdAt: IsoDate,
});

export const CommandSchema = z.discriminatedUnion("type", [
  ProjectCreateCommandSchema,
  WorktreeCreateCommandSchema,
  WorktreeRemoveCommandSchema,
  ThreadCreateCommandSchema,
  ThreadForkCommandSchema,
  ThreadCompactCommandSchema,
  ThreadTurnStartCommandSchema,
  ThreadTurnInterruptCommandSchema,
  ThreadApprovalRespondCommandSchema,
  ThreadGitActionCommandSchema,
  ThreadMessageAppendCommandSchema,
  ThreadMessageStreamCommandSchema,
  ThreadTurnCompleteCommandSchema,
  ThreadTurnFailCommandSchema,
  ThreadSessionSetCommandSchema,
  ThreadApprovalRequestCommandSchema,
  ThreadGitCompleteCommandSchema,
]);

export type ProjectCreateCommand = z.infer<typeof ProjectCreateCommandSchema>;
export type WorktreeCreateCommand = z.infer<typeof WorktreeCreateCommandSchema>;
export type WorktreeRemoveCommand = z.infer<typeof WorktreeRemoveCommandSchema>;
export type ThreadCreateCommand = z.infer<typeof ThreadCreateCommandSchema>;
export type ThreadForkCommand = z.infer<typeof ThreadForkCommandSchema>;
export type ThreadCompactCommand = z.infer<typeof ThreadCompactCommandSchema>;
export type ThreadTurnStartCommand = z.infer<typeof ThreadTurnStartCommandSchema>;
export type ThreadTurnInterruptCommand = z.infer<typeof ThreadTurnInterruptCommandSchema>;
export type ThreadApprovalRespondCommand = z.infer<typeof ThreadApprovalRespondCommandSchema>;
export type ThreadGitActionCommand = z.infer<typeof ThreadGitActionCommandSchema>;
export type ThreadMessageAppendCommand = z.infer<typeof ThreadMessageAppendCommandSchema>;
export type ThreadMessageStreamCommand = z.infer<typeof ThreadMessageStreamCommandSchema>;
export type ThreadTurnCompleteCommand = z.infer<typeof ThreadTurnCompleteCommandSchema>;
export type ThreadTurnFailCommand = z.infer<typeof ThreadTurnFailCommandSchema>;
export type ThreadSessionSetCommand = z.infer<typeof ThreadSessionSetCommandSchema>;
export type ThreadApprovalRequestCommand = z.infer<typeof ThreadApprovalRequestCommandSchema>;
export type ThreadGitCompleteCommand = z.infer<typeof ThreadGitCompleteCommandSchema>;
export type Command = z.infer<typeof CommandSchema>;

export type Message = z.infer<typeof MessageSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type GitAction = z.infer<typeof GitActionSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const EventBaseSchema = z.object({
  sequence: z.number().int().nonnegative(),
  eventId: z.string().min(1),
  aggregateKind: z.enum(["project", "worktree", "thread"]),
  aggregateId: z.string().min(1),
  streamVersion: z.number().int().nonnegative(),
  occurredAt: IsoDate,
  commandId: z.string().min(1),
});

export const ProjectCreatedEventSchema = EventBaseSchema.extend({
  type: z.literal("project.created"),
  aggregateKind: z.literal("project"),
  payload: z.object({
    projectId: z.string().min(1),
    title: z.string().min(1),
    workspaceRoot: z.string().min(1),
  }),
});

export const WorktreeCreatedEventSchema = EventBaseSchema.extend({
  type: z.literal("worktree.created"),
  aggregateKind: z.literal("worktree"),
  payload: z.object({
    worktreeId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    baseRef: z.string().min(1),
    branch: z.string().min(1),
    path: z.string().min(1),
  }),
});

export const WorktreeRemovedEventSchema = EventBaseSchema.extend({
  type: z.literal("worktree.removed"),
  aggregateKind: z.literal("worktree"),
  payload: z.object({
    worktreeId: z.string().min(1),
  }),
});

// --- thread events ----------------------------------------------------------

const ThreadEventBaseSchema = EventBaseSchema.extend({
  aggregateKind: z.literal("thread"),
});

export const ThreadCreatedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.created"),
  payload: z.object({
    threadId: z.string().min(1),
    projectId: z.string().min(1),
    worktreeId: z.string().min(1),
    title: z.string().min(1),
    hostId: z.string().min(1).optional(),
    parentThreadId: z.string().min(1).nullable().optional(),
    messages: z.array(MessageSchema).optional(),
  }),
});

export const ThreadCompactedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.compacted"),
  payload: z.object({
    threadId: z.string().min(1),
    messages: z.array(MessageSchema),
  }),
});

export const ThreadTurnStartedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.turn.started"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    prompt: z.string().min(1),
  }),
});

export const ThreadTurnInterruptedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.turn.interrupted"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
  }),
});

export const ThreadMessageAppendedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.message.appended"),
  payload: z.object({
    threadId: z.string().min(1),
    message: MessageSchema,
  }),
});

export const ThreadMessageDeltaEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.message.delta"),
  payload: z.object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    delta: z.string(),
  }),
});

export const ThreadTurnCompletedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.turn.completed"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
  }),
});

export const ThreadTurnFailedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.turn.failed"),
  payload: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    error: z.string(),
  }),
});

export const ThreadSessionSetEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.session.set"),
  payload: z.object({
    threadId: z.string().min(1),
    status: SessionStatusSchema,
  }),
});

export const ThreadApprovalRequestedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.approval.requested"),
  payload: z.object({
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    summary: z.string(),
  }),
});

export const ThreadApprovalRespondedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.approval.responded"),
  payload: z.object({
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    decision: ApprovalDecisionSchema,
  }),
});

export const ThreadGitRequestedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.git.requested"),
  payload: z.object({
    threadId: z.string().min(1),
    action: GitActionSchema,
    message: z.string().nullable(),
  }),
});

export const ThreadGitCompletedEventSchema = ThreadEventBaseSchema.extend({
  type: z.literal("thread.git.completed"),
  payload: z.object({
    threadId: z.string().min(1),
    action: GitActionSchema,
    ok: z.boolean(),
    summary: z.string(),
  }),
});

export const EventSchema = z.discriminatedUnion("type", [
  ProjectCreatedEventSchema,
  WorktreeCreatedEventSchema,
  WorktreeRemovedEventSchema,
  ThreadCreatedEventSchema,
  ThreadCompactedEventSchema,
  ThreadTurnStartedEventSchema,
  ThreadTurnInterruptedEventSchema,
  ThreadMessageAppendedEventSchema,
  ThreadMessageDeltaEventSchema,
  ThreadTurnCompletedEventSchema,
  ThreadTurnFailedEventSchema,
  ThreadSessionSetEventSchema,
  ThreadApprovalRequestedEventSchema,
  ThreadApprovalRespondedEventSchema,
  ThreadGitRequestedEventSchema,
  ThreadGitCompletedEventSchema,
]);

export type ProjectCreatedEvent = z.infer<typeof ProjectCreatedEventSchema>;
export type WorktreeCreatedEvent = z.infer<typeof WorktreeCreatedEventSchema>;
export type WorktreeRemovedEvent = z.infer<typeof WorktreeRemovedEventSchema>;
export type ThreadCreatedEvent = z.infer<typeof ThreadCreatedEventSchema>;
export type ThreadCompactedEvent = z.infer<typeof ThreadCompactedEventSchema>;
export type ThreadTurnStartedEvent = z.infer<typeof ThreadTurnStartedEventSchema>;
export type ThreadTurnInterruptedEvent = z.infer<typeof ThreadTurnInterruptedEventSchema>;
export type ThreadMessageAppendedEvent = z.infer<typeof ThreadMessageAppendedEventSchema>;
export type ThreadMessageDeltaEvent = z.infer<typeof ThreadMessageDeltaEventSchema>;
export type ThreadTurnCompletedEvent = z.infer<typeof ThreadTurnCompletedEventSchema>;
export type ThreadTurnFailedEvent = z.infer<typeof ThreadTurnFailedEventSchema>;
export type ThreadSessionSetEvent = z.infer<typeof ThreadSessionSetEventSchema>;
export type ThreadApprovalRequestedEvent = z.infer<typeof ThreadApprovalRequestedEventSchema>;
export type ThreadApprovalRespondedEvent = z.infer<typeof ThreadApprovalRespondedEventSchema>;
export type ThreadGitRequestedEvent = z.infer<typeof ThreadGitRequestedEventSchema>;
export type ThreadGitCompletedEvent = z.infer<typeof ThreadGitCompletedEventSchema>;
export type Event = z.infer<typeof EventSchema>;

// ---------------------------------------------------------------------------
// Read model / projections
// ---------------------------------------------------------------------------

export const ProjectSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  workspaceRoot: z.string().min(1),
});

export const WorktreeSchema = z.object({
  worktreeId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  baseRef: z.string().min(1),
  branch: z.string().min(1),
  path: z.string().min(1),
  createdAt: IsoDate,
});

export const ThreadSchema = z.object({
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  title: z.string().min(1),
  hostId: z.string().min(1).optional(),
  parentThreadId: z.string().min(1).nullable().optional(),
  messages: z.array(MessageSchema),
  session: z.object({ status: SessionStatusSchema }),
  currentTurnId: z.string().nullable(),
  createdAt: IsoDate,
});

export const ReadModelSchema = z.object({
  projects: z.array(ProjectSchema),
  worktrees: z.array(WorktreeSchema),
  threads: z.array(ThreadSchema),
  snapshotSequence: z.number().int().nonnegative(),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ReadModel = z.infer<typeof ReadModelSchema>;

// ---------------------------------------------------------------------------
// Provider runtime events (canonical, adapter → reactor boundary)
// ---------------------------------------------------------------------------

export const ProviderRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), threadId: z.string().min(1) }),
  z.object({ type: z.literal("message.delta"), threadId: z.string().min(1), text: z.string() }),
  z.object({ type: z.literal("message.completed"), threadId: z.string().min(1), text: z.string() }),
  z.object({
    type: z.literal("tool.started"),
    threadId: z.string().min(1),
    name: z.string().min(1),
    inputSummary: z.string(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    threadId: z.string().min(1),
    name: z.string().min(1),
    ok: z.boolean(),
  }),
  z.object({
    type: z.literal("approval.requested"),
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    summary: z.string(),
  }),
  z.object({ type: z.literal("turn.completed"), threadId: z.string().min(1) }),
  z.object({ type: z.literal("turn.failed"), threadId: z.string().min(1), error: z.string() }),
  z.object({ type: z.literal("session.ended"), threadId: z.string().min(1) }),
]);

export type ProviderRuntimeEvent = z.infer<typeof ProviderRuntimeEventSchema>;

// ---------------------------------------------------------------------------
// Command receipts
// ---------------------------------------------------------------------------

export const CommandReceiptSchema = z.object({
  commandId: z.string().min(1),
  aggregateKind: z.string().min(1),
  aggregateId: z.string().min(1),
  acceptedAt: IsoDate,
  resultSequence: z.number().int().nonnegative(),
  status: z.enum(["accepted", "rejected"]),
  error: z.string().nullable(),
});

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

// ---------------------------------------------------------------------------
// RPC contract
// ---------------------------------------------------------------------------

/** Body of `POST /rpc/dispatch`. */
export const DispatchRequestSchema = z.object({
  command: CommandSchema,
});

/** Success: the committed receipt; failure: an error message. */
export const DispatchResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), receipt: CommandReceiptSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** Query/params for a `subscribe` stream. */
export const SubscribeRequestSchema = z.object({
  fromSequence: z.number().int().nonnegative().optional(),
});

/** A single message on the `subscribe` stream. */
export const SubscribeEventSchema = z.object({
  event: EventSchema,
});

/** Response body of `GET /state`: the current read-model snapshot. */
export const StateResponseSchema = z.object({
  readModel: ReadModelSchema,
});

export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;
export type DispatchResponse = z.infer<typeof DispatchResponseSchema>;
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;
export type SubscribeEvent = z.infer<typeof SubscribeEventSchema>;
export type StateResponse = z.infer<typeof StateResponseSchema>;
