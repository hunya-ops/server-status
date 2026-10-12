import { useEffect, useId, useRef, useState } from "react";
import { Activity, ArrowUpRight, RefreshCw } from "lucide-react";
import { countryFlag, countryName } from "../shared/location";
import {
  UPTIME_DAYS,
  type PublicOverview,
  type PublicServer,
  type UptimeDay,
} from "../shared/uptime";
import { api } from "./api";
import "./public.css";

const stateNames = { online: "在线", offline: "上报中断", pending: "等待上报" };
const percent = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(2)}%`;
const dayState = (value: number | null) =>
  value === null
    ? "unknown"
    : value === 100
      ? "up"
      : value === 0
        ? "down"
        : "partial";

function duration(value: number | null): string {
  if (value === null) return "尚未上报";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  return days
    ? `${days} 天 ${hours} 小时`
    : hours
      ? `${hours} 小时 ${Math.floor((value % 3600) / 60)} 分钟`
      : `${Math.floor(value / 60)} 分钟`;
}

function dayLabel(day: UptimeDay): string {
  return `${day.date} · ${day.uptimePercent === null ? "暂无记录" : `Uptime ${percent(day.uptimePercent)}`}`;
}

function Timeline({ days, label }: { days: UptimeDay[]; label: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const tooltipId = useId();
  return (
    <div className="public-timeline" onMouseLeave={() => setSelected(null)}>
      <div
        className="public-bars"
        role="group"
        aria-label={`${label} 的 ${UPTIME_DAYS} 天记录`}
      >
        {days.map((day, index) => (
          <button
            key={day.date}
            type="button"
            className={`public-bar ${dayState(day.uptimePercent)} ${selected === index ? "selected" : ""}`}
            aria-label={dayLabel(day)}
            aria-describedby={selected === index ? tooltipId : undefined}
            tabIndex={index === (selected ?? days.length - 1) ? 0 : -1}
            onMouseEnter={() => setSelected(index)}
            onFocus={() => setSelected(index)}
            onBlur={() => setSelected(null)}
            onClick={() => setSelected(index)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSelected(null);
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const next =
                  event.currentTarget.parentElement?.children[
                    index + (event.key === "ArrowRight" ? 1 : -1)
                  ];
                if (next instanceof HTMLButtonElement) next.focus();
              }
            }}
          />
        ))}
      </div>
      {selected !== null && (
        <div
          className="public-day-tooltip"
          id={tooltipId}
          role="tooltip"
          style={{
            left: `clamp(84px, ${((selected + 0.5) / days.length) * 100}%, calc(100% - 84px))`,
          }}
        >
          <span>
            {days[selected].date} <small>UTC</small>
          </span>
          <strong>
            {days[selected].uptimePercent === null
              ? "暂无记录"
              : `Uptime ${percent(days[selected].uptimePercent)}`}
          </strong>
        </div>
      )}
    </div>
  );
}

function location(server: PublicServer): string {
  return (
    [countryName(server.country), server.city].filter(Boolean).join(" · ") ||
    "位置未知"
  );
}

export default function PublicStatus() {
  const [data, setData] = useState<PublicOverview | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const fetching = useRef(false);
  async function refresh() {
    if (fetching.current) return;
    fetching.current = true;
    setRefreshing(true);
    try {
      setData(await api<PublicOverview>("/api/public/uptime"));
      setError("");
    } catch {
      setError("暂时无法获取状态");
    } finally {
      fetching.current = false;
      setRefreshing(false);
    }
  }
  useEffect(() => {
    document.title = "Status · Uptime";
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const servers = data?.servers ?? [];
  const offline = servers.filter((server) => server.state === "offline").length;
  const pending = servers.filter((server) => server.state === "pending").length;
  const overall = error
    ? "unknown"
    : offline
      ? "down"
      : pending || !servers.length
        ? "unknown"
        : "up";
  const labels = servers.map(location);
  const seen = new Map<string, number>();
  const heading = error
    ? "状态暂不可用"
    : !data
      ? "正在读取状态"
      : !servers.length
        ? "暂无监控节点"
        : offline
          ? `${offline} 个节点上报中断`
          : pending
            ? `${pending} 个节点等待上报`
            : "所有节点运行正常";
  return (
    <div className="public-page">
      <div className="public-container">
        <header className="public-header">
          <a className="public-brand" href="/" aria-label="Status 首页">
            <Activity size={23} />
            <span>Status</span>
          </a>
          <span className="public-header-label">VPS Uptime</span>
        </header>
        <main>
          <section className={`public-summary ${overall}`} aria-live="polite">
            <span className="public-summary-dot" aria-hidden="true" />
            <div>
              <h1>{heading}</h1>
              <p>
                {data && !error
                  ? `${servers.length} 个节点 · 每 30 秒更新`
                  : ""}
              </p>
            </div>
            <button
              className="public-refresh"
              aria-label="刷新状态"
              title="刷新状态"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={19} className={refreshing ? "spin" : ""} />
            </button>
          </section>
          {error && (
            <p className="public-error" role="alert">
              {error}，请刷新重试{data ? "。下方为上次记录" : ""}。
            </p>
          )}
          <section className="public-history" aria-labelledby="uptime-title">
            <div className="public-section-heading">
              <h2 id="uptime-title">
                Uptime <span>最近 {UPTIME_DAYS} 天</span>
              </h2>
              <div className="public-legend" aria-label="历史状态图例">
                <span>
                  <i className="up" />
                  正常
                </span>
                <span>
                  <i className="partial" />
                  中断
                </span>
                <span>
                  <i className="unknown" />
                  无记录
                </span>
              </div>
            </div>
            <div className="public-rows" aria-busy={!data && refreshing}>
              {!data && !error ? (
                <div className="public-empty">
                  <Activity size={22} className="pulse" />
                  读取中
                </div>
              ) : !servers.length ? (
                <div className="public-empty">
                  {error ? "暂无可用状态" : "暂无监控节点"}
                </div>
              ) : (
                servers.map((server, index) => {
                  const base = labels[index];
                  const number = (seen.get(base) ?? 0) + 1;
                  seen.set(base, number);
                  const label =
                    labels.filter((value) => value === base).length > 1
                      ? `${base} ${number}`
                      : base;
                  return (
                    <article className="public-row" key={index}>
                      <div className="public-location">
                        <span className="public-flag" aria-hidden="true">
                          {countryFlag(server.country) || "◎"}
                        </span>
                        <div>
                          <h3>{label}</h3>
                          <p>
                            {server.uptimeSeconds === null
                              ? "尚未上报"
                              : `${server.state === "offline" ? "上次运行" : "连续运行"} ${duration(server.uptimeSeconds)}`}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`public-percentage ${dayState(server.uptimePercent)}`}
                        aria-label={`${label} 总 Uptime ${percent(server.uptimePercent)}`}
                      >
                        {percent(server.uptimePercent)}
                      </span>
                      <Timeline days={server.days} label={label} />
                      <span className={`public-node-state ${server.state}`}>
                        <i />
                        {stateNames[server.state]}
                      </span>
                    </article>
                  );
                })
              )}
              {servers.length > 0 && (
                <div className="public-date-axis">
                  <div>
                    <span>{servers[0].days[0].date}</span>
                    <span>今天</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </main>
        <footer className="public-footer">
          <span>
            按采集心跳统计 · UTC 日期
            {data
              ? ` · 更新于 ${new Date(data.generatedAt * 1000).toLocaleTimeString("zh-CN", { hour12: false })}`
              : ""}
          </span>
          <a href="/admin">
            管理面板 <ArrowUpRight size={13} />
          </a>
        </footer>
      </div>
    </div>
  );
}
