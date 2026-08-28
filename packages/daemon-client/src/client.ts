import { readFileSync } from "node:fs";
import type {
  ApprovalAnswer,
  DaemonDescriptor,
  DaemonEvent,
  HealthResponse,
  ScheduleRequest,
  TurnRequest,
} from "./protocol";
import { isDaemonEnvelope, isKnownDaemonEvent } from "./protocol";

export class DaemonClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}

export type DaemonClientOptions = {
  endpoint: string;
  token: string;
  fetch?: typeof fetch;
};

export function readDaemonDescriptor(path: string): DaemonDescriptor {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as DaemonDescriptor;
  if (
    parsed.v !== 1 ||
    typeof parsed.endpoint !== "string" ||
    typeof parsed.token !== "string" ||
    typeof parsed.pid !== "number"
  ) {
    throw new Error("daemon descriptor is invalid");
  }
  return parsed;
}

export class DaemonClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DaemonClientOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  static fromDescriptor(descriptor: DaemonDescriptor, fetchImpl?: typeof fetch): DaemonClient {
    return new DaemonClient({
      endpoint: descriptor.endpoint,
      token: descriptor.token,
      fetch: fetchImpl,
    });
  }

  async health(): Promise<HealthResponse> {
    const response = await this.request("GET", "/v1/health");
    return (await response.json()) as HealthResponse;
  }

  startTurn(request: TurnRequest): AsyncIterable<DaemonEvent> {
    return this.stream("POST", "/v1/turns", request);
  }

  events(turnId: string, after?: number): AsyncIterable<DaemonEvent> {
    const query = after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`;
    return this.stream("GET", `/v1/turns/${encodeURIComponent(turnId)}/events${query}`);
  }

  async approve(turnId: string, requestId: string, answer: ApprovalAnswer): Promise<void> {
    await this.request(
      "POST",
      `/v1/turns/${encodeURIComponent(turnId)}/approvals/${encodeURIComponent(requestId)}`,
      { answer },
    );
  }

  async cancel(turnId: string): Promise<void> {
    await this.request("POST", `/v1/turns/${encodeURIComponent(turnId)}/cancel`);
  }

  async search(
    query: string,
    options: { cwd?: string; sessionId?: string } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams({ q: query });
    if (options.cwd !== undefined) params.set("cwd", options.cwd);
    if (options.sessionId !== undefined) params.set("sessionId", options.sessionId);
    const response = await this.request("GET", `/v1/sessions/search?${params}`);
    return response.json();
  }

  async createSchedule(request: ScheduleRequest): Promise<unknown> {
    const response = await this.request("POST", "/v1/schedules", request);
    return response.json();
  }

  async listSchedules(): Promise<unknown> {
    const response = await this.request("GET", "/v1/schedules");
    return response.json();
  }

  async disableSchedule(id: string): Promise<void> {
    await this.request("DELETE", `/v1/schedules/${encodeURIComponent(id)}`);
  }

  async scheduleRuns(id: string): Promise<unknown> {
    const response = await this.request("GET", `/v1/schedules/${encodeURIComponent(id)}/runs`);
    return response.json();
  }

  authorizationHeader(): string {
    return `Bearer ${this.token}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.fetchImpl(new URL(path, `${this.endpoint}/`), {
      method,
      headers: {
        Authorization: this.authorizationHeader(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new DaemonClientError(`${method} ${path} failed: ${response.status}`, response.status);
    }
    return response;
  }

  private async *stream(method: string, path: string, body?: unknown): AsyncGenerator<DaemonEvent> {
    const response = await this.request(method, path, body);
    yield* iterateSse(response);
  }
}

export async function* iterateSse(response: Response): AsyncGenerator<DaemonEvent> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event !== undefined) yield event;
    }
  }
}

function parseSseBlock(block: string): DaemonEvent | undefined {
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trimStart();
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!isDaemonEnvelope(parsed)) return undefined;
      if (!isKnownDaemonEvent(parsed.event)) {
        return parsed;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
