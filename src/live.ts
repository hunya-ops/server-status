import type { Overview, ServerSnapshot } from "../shared/types";
import type { PublicOverview, PublicServer } from "../shared/uptime";
export type LiveMessage<T, S> =
  | { type: "snapshot"; data: T }
  | { type: "update"; server: S; index?: number; generatedAt: number };
export type LiveStatus =
  "connecting" | "connected" | "refreshing" | "reconnecting";
export function applyPrivate(
  current: Overview | null,
  message: LiveMessage<Overview, ServerSnapshot>,
): Overview | null {
  if (message.type === "snapshot") return message.data;
  if (!current) return null;
  return {
    ...current,
    generatedAt: message.generatedAt,
    servers: current.servers.map((s) =>
      s.id === message.server.id ? message.server : s,
    ),
  };
}
export function applyPublic(
  current: PublicOverview | null,
  message: LiveMessage<PublicOverview, PublicServer>,
): PublicOverview | null {
  if (message.type === "snapshot") return message.data;
  if (
    !current ||
    message.index === undefined ||
    message.index < 0 ||
    message.index >= current.servers.length
  )
    return current;
  return {
    ...current,
    generatedAt: message.generatedAt,
    servers: current.servers.map((s, i) =>
      i === message.index ? message.server : s,
    ),
  };
}
export function stalePublic(
  data: PublicOverview | null,
  now: number,
): PublicOverview | null {
  if (!data || now - data.generatedAt < 15) return data;
  return {
    ...data,
    servers: data.servers.map((s) =>
      s.state === "online" ? { ...s, state: "stale" } : s,
    ),
  };
}

// Reconnects always require a fresh snapshot. Heartbeats detect silent broken
// connections (including a browser waking up after a suspended network).
export class LiveStream {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private failures = 0;
  private received = Date.now();
  constructor(
    private path: string,
    private message: (value: any) => void,
    private status: (state: LiveStatus) => void,
    private unauthorized: () => void = () => {},
    private create: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}
  start(state: Exclude<LiveStatus, "connected"> = "connecting") {
    if (this.stopped) return;
    this.status(state);
    this.received = Date.now();
    const url = new URL(this.path, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = this.create(url.toString());
    this.ws = ws;
    let snapshot = false;
    ws.onopen = () => {
      this.received = Date.now();
    };
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this.received = Date.now();
      if (event.data === "pong") return;
      try {
        const value = JSON.parse(event.data);
        if (value.type === "snapshot") {
          snapshot = true;
          this.failures = 0;
          this.status("connected");
        }
        if (snapshot && ["snapshot", "update"].includes(value.type))
          this.message(value);
      } catch {
        ws.close();
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      clearInterval(this.heartbeat);
      this.status("reconnecting");
      if (event.code === 4401) {
        this.stop();
        this.unauthorized();
        return;
      }
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.start("reconnecting"),
          Math.min(10000, 500 * 2 ** Math.min(this.failures++, 5)) *
            (0.5 + Math.random() * 0.5),
        );
    };
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.received >= 15000) {
        this.restart("reconnecting");
        return;
      }
      if (ws.readyState === 1) ws.send("ping");
    }, 5000);
  }
  restart(state: "refreshing" | "reconnecting" = "refreshing") {
    if (this.stopped) return;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.start(state);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
  }
}
