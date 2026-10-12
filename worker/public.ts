import { STALE_SECONDS } from "../shared/types";
import {
  DAY_SECONDS,
  UPTIME_DAYS,
  uptimeHistory,
  type PublicOverview,
  type PublicServer,
  type UptimeInterval,
} from "../shared/uptime";
import { json } from "./http";

interface PublicRow {
  id: string;
  country: string | null;
  city: string | null;
  received_at: number | null;
  interval_seconds: number;
  uptime_seconds: number | null;
  started_at: number | null;
}

export async function publicOverview(
  env: { DB: D1Database },
  now: number,
): Promise<Response> {
  const start =
    Math.floor(now / DAY_SECONDS) * DAY_SECONDS -
    (UPTIME_DAYS - 1) * DAY_SECONDS;
  // Select only the data needed for the public projection; never read names,
  // IP addresses, credentials or the complete private report here.
  const [rows, history] = await env.DB.batch([
    env.DB
      .prepare(`SELECT s.id, s.interval_seconds, p.country, p.city, p.received_at,
      json_extract(p.payload, '$.uptimeSeconds') AS uptime_seconds, t.started_at
      FROM servers s LEFT JOIN snapshots p ON p.server_id = s.id
      LEFT JOIN uptime_tracking t ON t.server_id = s.id
      WHERE s.enabled = 1
      ORDER BY p.country IS NULL, p.country COLLATE NOCASE,
        p.city IS NULL, p.city COLLATE NOCASE, s.sort_order, s.id`),
    env.DB.prepare(
      `SELECT u.server_id, u.started_at, u.ended_at FROM uptime_intervals u
      JOIN servers s ON s.id = u.server_id WHERE s.enabled = 1 AND u.ended_at > ?`,
    ).bind(start),
  ]);
  const intervals = new Map<string, UptimeInterval[]>();
  for (const interval of history.results as unknown as (UptimeInterval & {
    server_id: string;
  })[]) {
    const list = intervals.get(interval.server_id) ?? [];
    list.push(interval);
    intervals.set(interval.server_id, list);
  }
  const servers: PublicServer[] = (rows.results as unknown as PublicRow[]).map(
    (row) => ({
      country: row.country,
      city: row.city,
      state:
        row.received_at === null
          ? "pending"
          : now - row.received_at >
              Math.max(STALE_SECONDS, row.interval_seconds * 3)
            ? "offline"
            : "online",
      uptimeSeconds: row.uptime_seconds,
      ...uptimeHistory(row.started_at, intervals.get(row.id) ?? [], now),
    }),
  );
  return json({ generatedAt: now, servers } satisfies PublicOverview);
}
