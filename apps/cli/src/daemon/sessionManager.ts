import { randomUUID } from "node:crypto";
import {
  type ApprovalAnswer,
  type DaemonEvent,
  isLoopDaemonEvent,
  type PublicLoopEvent,
} from "@seri/daemon-client";
import type { PermissionMode } from "../gate/gate";
import type { LoopEvent } from "../loop/loop";
import type { PromptChannel } from "../permissions/promptChannel";
import type { SessionDatabase } from "../session/database";
import type { SessionState } from "../session/session";

// The `as PublicLoopEvent` cast below is what puts a LoopEvent on the wire without the compiler
// ever comparing the two unions, so a member added to one and not the other ships silently. This
// line is the comparison that cast skips. It fired for real: `permission-denied` grew a "hook"
// reason in loop.ts and the daemon emitted it for a week's worth of edits under a wire type that
// said it could not occur. Widen protocol.ts when you widen loop.ts, and this stays green.
type DenialReason<E extends { type: string }> = Extract<
  E,
  { type: "permission-denied"; reason: string }
>["reason"];
// Assert<T extends true>, not a bare conditional resolving to a message string: a conditional type
// that evaluates to something other than `true` is still a perfectly legal type and compiles
// silently. Verified by narrowing protocol.ts back and watching this line, and only this line, go
// red. A conditional alone did nothing at all.
type Assert<T extends true> = T;
type _WireCarriesEveryDenialReason = Assert<
  DenialReason<LoopEvent> extends DenialReason<PublicLoopEvent> ? true : false
>;

export type ExecuteTurnInput = {
  turnId: string;
  sessionId: string;
  task: string;
  cwd: string;
  permissionMode: PermissionMode;
  promptChannel?: PromptChannel;
  signal: AbortSignal;
  emitLoop: (event: { type: string } & Record<string, unknown>) => void;
  requestApproval: (requestId: string, toolName: string, args: unknown) => Promise<ApprovalAnswer>;
};

export type ExecuteTurn = (input: ExecuteTurnInput) => Promise<{ exitCode: 0 | 1 }>;

type Subscriber = (event: DaemonEvent) => void;

type PendingApproval = {
  requestId: string;
  resolve: (answer: ApprovalAnswer) => void;
};

type TurnHandle = {
  sessionId: string;
  abort: AbortController;
  seq: number;
  replay: DaemonEvent[];
  subscribers: Set<Subscriber>;
  pendingApproval: PendingApproval | undefined;
  finished: boolean;
};

type SessionHandle = {
  tail: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  generation: number;
};

export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export type SessionManagerOptions = {
  idleMs?: number;
  onIdleFlush?: (sessionId: string, signal: AbortSignal) => Promise<void>;
};

export class DaemonSessionManager {
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly turns = new Map<string, TurnHandle>();
  private readonly idleMs: number;
  private readonly onIdleFlush:
    | ((sessionId: string, signal: AbortSignal) => Promise<void>)
    | undefined;
  private readonly shutdown = new AbortController();
  readonly evictedSessionIds: string[] = [];

  constructor(
    private readonly database: SessionDatabase,
    private readonly executeTurn: ExecuteTurn,
    opts: SessionManagerOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.onIdleFlush = opts.onIdleFlush;
  }

  getTurn(turnId: string): TurnHandle | undefined {
    return this.turns.get(turnId);
  }

  async startTurn(request: {
    task: string;
    sessionId?: string;
    cwd?: string;
    permissionMode?: PermissionMode;
    promptChannel?: PromptChannel;
  }): Promise<{ turnId: string; sessionId: string; subscribe: (send: Subscriber) => () => void }> {
    const session = this.resolveSession(request);
    const turnId = randomUUID();
    const abort = new AbortController();
    const handle: TurnHandle = {
      sessionId: session.id,
      abort,
      seq: 0,
      replay: [],
      subscribers: new Set(),
      pendingApproval: undefined,
      finished: false,
    };
    this.turns.set(turnId, handle);
    this.database.insertTurn(turnId, session.id, new Date().toISOString());

    const sessionHandle = this.sessionHandle(session.id);
    sessionHandle.generation += 1;
    if (sessionHandle.idleTimer !== undefined) {
      clearTimeout(sessionHandle.idleTimer);
      sessionHandle.idleTimer = undefined;
    }
    const gate = Promise.withResolvers<void>();
    sessionHandle.tail = sessionHandle.tail
      .then(async () => {
        await gate.promise;
        await this.runTurn(
          turnId,
          handle,
          session,
          request.task,
          request.permissionMode,
          request.promptChannel,
        );
      })
      .catch(() => {});

    return {
      turnId,
      sessionId: session.id,
      subscribe: (send) => {
        handle.subscribers.add(send);
        gate.resolve();
        return () => {
          handle.subscribers.delete(send);
          this.onSubscriberGone(handle);
        };
      },
    };
  }

  replayAndFollow(turnId: string, afterSeq: number, send: Subscriber): (() => void) | undefined {
    const handle = this.turns.get(turnId);
    if (handle !== undefined) {
      for (const event of handle.replay) {
        if (event.seq > afterSeq) send(event);
      }
      if (handle.finished) return undefined;
      handle.subscribers.add(send);
      return () => {
        handle.subscribers.delete(send);
        this.onSubscriberGone(handle);
      };
    }
    const persisted = this.database.listDaemonEventsAfter(turnId, afterSeq) as DaemonEvent[];
    for (const event of persisted) send(event);
    return undefined;
  }

  resolveApproval(turnId: string, requestId: string, answer: ApprovalAnswer): boolean {
    const handle = this.turns.get(turnId);
    if (handle?.pendingApproval?.requestId !== requestId) return false;
    const pending = handle.pendingApproval;
    handle.pendingApproval = undefined;
    pending.resolve(answer);
    return true;
  }

  cancelTurn(turnId: string): boolean {
    const handle = this.turns.get(turnId);
    if (handle === undefined || handle.finished) return false;
    handle.abort.abort();
    if (handle.pendingApproval !== undefined) {
      handle.pendingApproval.resolve("no");
      handle.pendingApproval = undefined;
    }
    return true;
  }

  cancelAll(): void {
    this.shutdown.abort();
    for (const turnId of this.turns.keys()) this.cancelTurn(turnId);
    for (const handle of this.sessions.values()) {
      if (handle.idleTimer !== undefined) clearTimeout(handle.idleTimer);
      handle.idleTimer = undefined;
    }
  }

  waitForIdle(): Promise<void> {
    return Promise.all([...this.sessions.values()].map((session) => session.tail)).then(() => {});
  }

  private sessionHandle(sessionId: string): SessionHandle {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created = { tail: Promise.resolve(), idleTimer: undefined, generation: 0 };
    this.sessions.set(sessionId, created);
    return created;
  }

  private resolveSession(request: {
    sessionId?: string;
    cwd?: string;
    permissionMode?: PermissionMode;
  }): SessionState {
    if (request.sessionId !== undefined) {
      const loaded = this.database.loadSession(request.sessionId);
      if (loaded === undefined) throw new SessionNotFoundError(request.sessionId);
      return loaded;
    }
    const session: SessionState = {
      id: randomUUID(),
      cwd: request.cwd ?? process.cwd(),
      systemPrompt: "",
      permissionMode: request.permissionMode ?? "approve-each",
      messages: [],
    };
    this.database.saveSession(session);
    return session;
  }

  private async runTurn(
    turnId: string,
    handle: TurnHandle,
    session: SessionState,
    task: string,
    permissionMode: PermissionMode | undefined,
    promptChannel: PromptChannel | undefined,
  ): Promise<void> {
    const emit = (event: DaemonEvent["event"]) => {
      handle.seq += 1;
      const envelope: DaemonEvent = {
        v: 1,
        sessionId: session.id,
        turnId,
        seq: handle.seq,
        event,
      };
      handle.replay.push(envelope);
      const persist =
        !isLoopDaemonEvent(event) ||
        (event.value.type !== "text-delta" && event.value.type !== "reasoning-delta");
      if (persist) this.database.appendDaemonEvent(turnId, handle.seq, envelope);
      for (const subscriber of handle.subscribers) subscriber(envelope);
    };

    try {
      const result = await this.executeTurn({
        turnId,
        sessionId: session.id,
        task,
        cwd: session.cwd,
        permissionMode: permissionMode ?? session.permissionMode,
        promptChannel,
        signal: handle.abort.signal,
        emitLoop: (value) => {
          if (value.type === "messages-updated") return;
          emit({ type: "loop", value: value as PublicLoopEvent });
        },
        requestApproval: (requestId, toolName, args) =>
          new Promise<ApprovalAnswer>((resolve) => {
            handle.pendingApproval = { requestId, resolve };
            emit({ type: "approval-request", requestId, toolName, args });
          }),
      });
      emit({ type: "turn-complete", exitCode: result.exitCode });
    } catch (error) {
      emit({
        type: "loop",
        value: { type: "error", error: error instanceof Error ? error.message : String(error) },
      });
      emit({ type: "turn-complete", exitCode: 1 });
    } finally {
      handle.finished = true;
      handle.pendingApproval = undefined;
      this.database.finishTurn(turnId, new Date().toISOString());
      handle.subscribers.clear();
      this.turns.delete(turnId);
      this.armIdle(session.id);
    }
  }

  private sessionHasLiveTurn(sessionId: string): boolean {
    for (const handle of this.turns.values()) {
      if (handle.sessionId === sessionId && !handle.finished) return true;
    }
    return false;
  }

  private armIdle(sessionId: string): void {
    if (this.idleMs <= 0) return;
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    if (this.sessionHasLiveTurn(sessionId)) return;
    if (handle.idleTimer !== undefined) clearTimeout(handle.idleTimer);
    handle.idleTimer = setTimeout(() => {
      void this.flushIdle(sessionId);
    }, this.idleMs);
  }

  private async flushIdle(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    handle.idleTimer = undefined;
    const generation = handle.generation;
    handle.tail = handle.tail
      .then(async () => {
        if (handle.generation !== generation) return;
        await this.onIdleFlush?.(sessionId, this.shutdown.signal);
        if (handle.generation !== generation) return;
        this.sessions.delete(sessionId);
        this.evictedSessionIds.push(sessionId);
      })
      .catch(() => {});
  }

  private onSubscriberGone(handle: TurnHandle): void {
    if (handle.subscribers.size > 0) return;
    if (handle.pendingApproval === undefined) return;
    const pending = handle.pendingApproval;
    handle.pendingApproval = undefined;
    pending.resolve("no");
  }
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}
