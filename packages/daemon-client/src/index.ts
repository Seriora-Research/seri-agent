export type { DaemonClientOptions } from "./client";
export {
  DaemonClient,
  DaemonClientError,
  iterateSse,
  readDaemonDescriptor,
} from "./client";
export type {
  ApprovalAnswer,
  DaemonDescriptor,
  DaemonEvent,
  HealthResponse,
  PermissionModeWire,
  PublicLoopEvent,
  ScheduleRequest,
  ScheduleTiming,
  TurnRequest,
} from "./protocol";
export {
  isDaemonEnvelope,
  isKnownDaemonEvent,
  isLoopDaemonEvent,
} from "./protocol";
