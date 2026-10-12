export const UPTIME_DAYS = 90;
export const DAY_SECONDS = 86400;

export interface UptimeDay {
  date: string;
  uptimePercent: number | null;
}

export interface PublicServer {
  country: string | null;
  city: string | null;
  state: "online" | "offline" | "pending";
  uptimeSeconds: number | null;
  cpuCores: number | null;
  memoryTotalBytes: number | null;
  diskTotalBytes: number | null;
  uptimePercent: number | null;
  days: UptimeDay[];
}

export interface PublicOverview {
  generatedAt: number;
  servers: PublicServer[];
}

export interface UptimeInterval {
  started_at: number;
  ended_at: number;
}

export function uptimeHistory(
  startedAt: number | null,
  intervals: UptimeInterval[],
  now: number,
): { days: UptimeDay[]; uptimePercent: number | null } {
  const firstDay =
    Math.floor(now / DAY_SECONDS) * DAY_SECONDS -
    (UPTIME_DAYS - 1) * DAY_SECONDS;
  let totalObserved = 0;
  let totalOnline = 0;
  const days = Array.from({ length: UPTIME_DAYS }, (_, index) => {
    const day = firstDay + index * DAY_SECONDS;
    const start = Math.max(day, startedAt ?? now);
    const end = Math.min(day + DAY_SECONDS, now);
    const observed = Math.max(0, end - start);
    const online = intervals.reduce(
      (seconds, interval) =>
        seconds +
        Math.max(
          0,
          Math.min(end, interval.ended_at) -
            Math.max(start, interval.started_at),
        ),
      0,
    );
    totalObserved += observed;
    totalOnline += online;
    return {
      date: new Date(day * 1000).toISOString().slice(0, 10),
      uptimePercent: observed ? Math.min(100, (online / observed) * 100) : null,
    };
  });
  return {
    days,
    uptimePercent: totalObserved
      ? Math.min(100, (totalOnline / totalObserved) * 100)
      : null,
  };
}
