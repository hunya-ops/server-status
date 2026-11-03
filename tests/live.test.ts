import { afterEach, expect, it, vi } from "vitest";
import {
  applyPrivate,
  applyPublic,
  LiveStream,
  stalePublic,
} from "../src/live";
import { DEFAULT_SETTINGS, type Overview } from "../shared/types";
import type { PublicOverview } from "../shared/uptime";
const node = { id: "alpha", name: "Alpha", lastSeen: null, report: null };
const overview: Overview = {
  generatedAt: 1000,
  settings: DEFAULT_SETTINGS,
  servers: [node],
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("applies a complete snapshot before isolated incremental updates", () => {
  expect(applyPrivate(null, { type: "snapshot", data: overview })).toBe(
    overview,
  );
  expect(
    applyPrivate(null, { type: "update", server: node, generatedAt: 1005 }),
  ).toBeNull();
  expect(
    applyPrivate(overview, {
      type: "update",
      server: { ...node, name: "Renamed" },
      generatedAt: 1005,
    })!.servers[0].name,
  ).toBe("Renamed");
  const pub: PublicOverview = { generatedAt: 1000, servers: [] };
  expect(applyPublic(null, { type: "snapshot", data: pub })).toBe(pub);
  const server = {
    country: null,
    city: null,
    state: "online" as const,
    uptimeSeconds: 1,
    cpuCores: 1,
    memoryTotalBytes: 1,
    diskTotalBytes: 1,
    uptimePercent: null,
    days: [],
  };
  const current = {
    ...pub,
    servers: [server, { ...server, state: "offline" as const }],
  };
  expect(
    applyPublic(current, {
      type: "update",
      index: 0,
      server: { ...server, state: "stale" },
      generatedAt: 1005,
    })!.servers.map((s) => s.state),
  ).toEqual(["stale", "offline"]);
  expect(stalePublic(current, 1016)!.servers.map((s) => s.state)).toEqual([
    "stale",
    "offline",
  ]);
});
it("reconnects after loss, discards deltas before a fresh snapshot and releases timers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { href: "https://status.example/admin" });
  const sockets: any[] = [];
  const make = () => {
    const ws: any = { readyState: 1, close: vi.fn(), send: vi.fn() };
    sockets.push(ws);
    return ws;
  };
  const message = vi.fn(),
    status = vi.fn(),
    unauthorized = vi.fn();
  const stream = new LiveStream(
    "/api/live",
    message,
    status,
    unauthorized,
    make,
  );
  stream.start();
  expect(status).toHaveBeenLastCalledWith("connecting");
  sockets[0].onmessage({
    data: JSON.stringify({ type: "update", server: node, generatedAt: 1000 }),
  });
  expect(message).not.toHaveBeenCalled();
  sockets[0].onmessage({
    data: JSON.stringify({ type: "snapshot", data: overview }),
  });
  expect(message).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenLastCalledWith("connected");
  sockets[0].onclose({ code: 1006 });
  expect(status).toHaveBeenLastCalledWith("reconnecting");
  await vi.advanceTimersByTimeAsync(1000);
  expect(sockets).toHaveLength(2);
  sockets[1].onmessage({
    data: JSON.stringify({ type: "update", server: node }),
  });
  expect(message).toHaveBeenCalledTimes(1);
  sockets[1].onmessage({
    data: JSON.stringify({ type: "snapshot", data: overview }),
  });
  expect(message).toHaveBeenCalledTimes(2);
  expect(status).toHaveBeenLastCalledWith("connected");
  sockets[1].onclose({ code: 4401 });
  expect(unauthorized).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a healthy quiet stream alive with pongs and reconnects a silent transport", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { href: "https://status.example/" });
  const sockets: any[] = [];
  const make = () => {
    const ws: any = { readyState: 1, close: vi.fn(), send: vi.fn() };
    sockets.push(ws);
    return ws;
  };
  const status = vi.fn();
  const stream = new LiveStream(
    "/api/public/live",
    () => {},
    status,
    () => {},
    make,
  );
  stream.start();
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "snapshot",
      data: { generatedAt: 1000, servers: [] },
    }),
  });
  for (let i = 0; i < 6; i++) {
    await vi.advanceTimersByTimeAsync(5000);
    sockets[0].onmessage({ data: "pong" });
  }
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15000);
  expect(sockets).toHaveLength(2);
  expect(status).toHaveBeenLastCalledWith("reconnecting");
  stream.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("refreshes on return from a suspended page without reporting a connection failure", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { href: "https://status.example/" });
  const sockets: any[] = [];
  const make = () => {
    const ws: any = { readyState: 1, close: vi.fn(), send: vi.fn() };
    sockets.push(ws);
    return ws;
  };
  const message = vi.fn(),
    status = vi.fn();
  const snapshot = JSON.stringify({ type: "snapshot", data: overview });
  const stream = new LiveStream(
    "/api/public/live",
    message,
    status,
    () => {},
    make,
  );
  stream.start();
  sockets[0].onmessage({ data: snapshot });

  // A suspended tab can return long after its last heartbeat.
  vi.setSystemTime(Date.now() + 60000);
  stream.restart();
  expect(status).toHaveBeenLastCalledWith("refreshing");
  expect(sockets[0].close).toHaveBeenCalledOnce();
  expect(sockets[0].onclose).toBeNull();
  sockets[0].onmessage({ data: snapshot });
  sockets[1].onmessage({
    data: JSON.stringify({ type: "update", server: node }),
  });
  expect(message).toHaveBeenCalledTimes(1);

  // The replacement connection gets time to establish, even after suspension.
  await vi.advanceTimersByTimeAsync(5000);
  expect(sockets).toHaveLength(2);
  expect(status).toHaveBeenLastCalledWith("refreshing");
  sockets[1].onmessage({ data: snapshot });
  expect(message).toHaveBeenCalledTimes(2);
  expect(status.mock.calls.map(([value]) => value)).toEqual([
    "connecting",
    "connected",
    "refreshing",
    "connected",
  ]);

  // Manual refresh uses the same quiet refresh path.
  stream.restart();
  expect(status).toHaveBeenLastCalledWith("refreshing");
  sockets[2].onmessage({ data: snapshot });
  expect(status).toHaveBeenLastCalledWith("connected");
  stream.stop();
  stream.restart();
  expect(sockets).toHaveLength(3);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["close", "timeout"])(
  "reports a real %s failure during refresh",
  async (failure) => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { href: "https://status.example/" });
    const sockets: any[] = [];
    const make = () => {
      const ws: any = { readyState: 1, close: vi.fn(), send: vi.fn() };
      sockets.push(ws);
      return ws;
    };
    const status = vi.fn();
    const stream = new LiveStream(
      "/api/public/live",
      () => {},
      status,
      () => {},
      make,
    );
    stream.start();
    sockets[0].onmessage({
      data: JSON.stringify({ type: "snapshot", data: overview }),
    });
    stream.restart();
    expect(status).toHaveBeenLastCalledWith("refreshing");
    if (failure === "close") sockets[1].onclose({ code: 1006 });
    else await vi.advanceTimersByTimeAsync(15000);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
  },
);
