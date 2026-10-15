import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Cpu,
  HardDrive,
  LayoutGrid,
  List,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MemoryStick,
  RefreshCw,
  Search,
  Server,
  X,
  Plus,
  Pencil,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  DEFAULT_SETTINGS,
  type Settings,
  serverState,
  maxDiskUsage,
  type Overview,
  type ServerSnapshot,
  type HistoryPoint,
  type ServerState,
} from "../shared/types";

import { api, ApiError } from "./api";
import {
  RenameServerDialog,
  ServerManager,
  SettingsDialog,
} from "./Management";
import { ServerNetwork } from "./ServerNetwork";
import { locationName } from "../shared/location";
const BrandContext = createContext("Status");
const WarningContext = createContext(90);

const percent = (value: number) => `${value.toFixed(1)}%`;
function bytes(value: number): string {
  if (value === 0) return "0 B";
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit < 2 ? 0 : 1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
function duration(value: number): string {
  const days = Math.floor(value / 86400);
  return days > 0
    ? `${days} 天 ${Math.floor((value % 86400) / 3600)} 小时`
    : `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分钟`;
}
function age(lastSeen: number | null, now: number): string {
  if (lastSeen === null) return "尚未上报";
  const seconds = Math.max(0, Math.floor(now - lastSeen));
  return seconds < 60
    ? `${seconds} 秒前`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟前`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} 小时前`
        : `${Math.floor(seconds / 86400)} 天前`;
}
const stateNames: Record<ServerState, string> = {
  online: "在线",
  warning: "占用较高",
  offline: "上报中断",
  pending: "等待上报",
  disabled: "已停用",
};
function Badge({ state }: { state: ServerState }) {
  return (
    <span className={`state-badge ${state}`}>
      <i />
      {stateNames[state]}
    </span>
  );
}
function Logo() {
  const title = useContext(BrandContext);
  return (
    <div className="logo">
      <span className="logo-icon">
        <Activity size={22} strokeWidth={2} />
      </span>
      <span>{title}</span>
    </div>
  );
}

function Login({
  onLogin,
  setupRequired = false,
}: {
  onLogin: () => void;
  setupRequired?: boolean;
}) {
  const [setupKey, setSetupKey] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    if (setupRequired && password !== repeatPassword) {
      setError("两次密码不一致");
      setBusy(false);
      return;
    }
    try {
      await api(setupRequired ? "/api/setup" : "/api/login", {
        method: "POST",
        body: JSON.stringify({
          password,
          ...(setupRequired ? { setupKey } : {}),
        }),
      });
      onLogin();
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法登录");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-box">
        <Logo />
        <div className="login-lock">
          <LockKeyhole size={24} />
        </div>
        <h1>{setupRequired ? "初始化面板" : "登录监控面板"}</h1>
        <form onSubmit={submit} method="post">
          {setupRequired && (
            <label>
              初始化密钥
              <input
                name="setupKey"
                type="password"
                value={setupKey}
                autoComplete="off"
                required
                minLength={32}
                maxLength={256}
                onChange={(event) => setSetupKey(event.target.value)}
                placeholder="部署时填写的 SETUP_KEY"
              />
            </label>
          )}
          <label htmlFor="username">
            用户名
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              value="admin"
              readOnly
            />
          </label>
          <label htmlFor="password">
            {setupRequired ? "设置访问密码" : "访问密码"}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={setupRequired ? "new-password" : "current-password"}
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            maxLength={256}
            minLength={setupRequired ? 12 : undefined}
            placeholder={setupRequired ? "至少 12 个字符" : "输入访问密码"}
          />
          {setupRequired && (
            <label className="repeat-password">
              确认密码
              <input
                name="repeatPassword"
                type="password"
                autoComplete="new-password"
                value={repeatPassword}
                required
                minLength={12}
                maxLength={256}
                onChange={(event) => setRepeatPassword(event.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={busy}>
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <span>{setupRequired ? "创建面板" : "登录"}</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function Meter({
  label,
  icon: Icon,
  value,
  caption,
}: {
  label: string;
  icon: typeof Cpu;
  value?: number;
  caption?: string;
}) {
  const warning = useContext(WarningContext);
  const tone =
    value !== undefined && value >= warning
      ? "high"
      : value !== undefined && value >= (warning * 5) / 6
        ? "medium"
        : "";
  return (
    <div className={`meter ${tone}`}>
      <div className="meter-top">
        <span>
          <Icon size={15} />
          {label}
        </span>
        <strong>{value === undefined ? "—" : percent(value)}</strong>
      </div>
      <div className="meter-track">
        <div style={{ width: `${value || 0}%` }} />
      </div>
      <div className="meter-caption">{caption || "—"}</div>
    </div>
  );
}

function ServerCard({
  server,
  now,
  onOpen,
}: {
  server: ServerSnapshot;
  now: number;
  onOpen: () => void;
}) {
  const state = serverState(server, now);
  const report = server.report;
  const disk = report?.disks.reduce((a, b) =>
    a.usagePercent > b.usagePercent ? a : b,
  );
  return (
    <button
      className={`server-card ${state}`}
      onClick={onOpen}
      aria-label={`查看 ${server.name} 的指标`}
    >
      <div className="card-header">
        <span className="server-symbol">
          <Server size={20} />
        </span>
        <Badge state={state} />
      </div>
      <div className="card-name">
        <h2>{server.name}</h2>
        <ArrowUpRight size={18} />
      </div>
      <p className="server-meta">
        {report ? `${report.os} · ${report.cpu.cores} 核` : "—"}
      </p>
      <ServerNetwork server={server} />
      <div className="card-metrics">
        <Meter
          label="CPU"
          icon={Cpu}
          value={report?.cpu.usagePercent}
          caption={report ? `负载 ${report.cpu.load1.toFixed(2)}` : undefined}
        />
        <Meter
          label="内存"
          icon={MemoryStick}
          value={report?.memory.usagePercent}
          caption={
            report
              ? `${bytes(report.memory.usedBytes)} / ${bytes(report.memory.totalBytes)}`
              : undefined
          }
        />
        <Meter
          label="磁盘"
          icon={HardDrive}
          value={disk?.usagePercent}
          caption={
            disk
              ? `${disk.mount} · ${bytes(disk.usedBytes)} / ${bytes(disk.totalBytes)}`
              : undefined
          }
        />
      </div>
      <div className="card-bottom">
        <span>
          <Clock3 size={13} />
          {report ? duration(report.uptimeSeconds) : "—"}
        </span>
        <span>{age(server.lastSeen, now)}</span>
      </div>
    </button>
  );
}

function Chart({
  points,
  field,
  step,
  start,
  end,
  color,
  label,
}: {
  points: HistoryPoint[];
  field: "cpu" | "memory" | "disk";
  step: number;
  start: number;
  end: number;
  color: string;
  label: string;
}) {
  const [hover, setHover] = useState<HistoryPoint | null>(null);
  const width = 640,
    height = 170,
    padding = 6;
  const x = (time: number) =>
    padding +
    Math.max(0, Math.min(1, (time - start) / (end - start))) *
      (width - padding * 2);
  const y = (value: number) => 6 + ((100 - value) / 100) * (height - 16);
  const paths: HistoryPoint[][] = [];
  for (const point of points) {
    const last = paths.at(-1)?.at(-1);
    if (!last || point.time - last.time > step * 2) paths.push([point]);
    else paths.at(-1)!.push(point);
  }
  function move(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const target =
      start + ((event.clientX - box.left) / box.width) * (end - start);
    const nearest = points.reduce<HistoryPoint | null>(
      (best, point) =>
        !best || Math.abs(point.time - target) < Math.abs(best.time - target)
          ? point
          : best,
      null,
    );
    setHover(
      nearest && Math.abs(nearest.time - target) <= step * 2 ? nearest : null,
    );
  }
  const time = (value: number) =>
    new Date(value * 1000).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  const dateTime = (value: number) =>
    end - start >= 86400
      ? new Date(value * 1000).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : time(value);
  return (
    <div className="chart">
      <div className="chart-heading">
        <span>{label}</span>
        <strong style={{ color }}>
          {hover
            ? `${dateTime(hover.time)} · ${percent(hover[field])}`
            : points.length
              ? percent(points.at(-1)![field])
              : "—"}
        </strong>
      </div>
      <div className="chart-plot">
        <div className="chart-y-labels">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}历史曲线`}
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        >
          {[0, 50, 100].map((value) => (
            <line
              key={value}
              x1={0}
              x2={width}
              y1={y(value)}
              y2={y(value)}
              className="chart-grid"
            />
          ))}
          {paths.map((segment, index) => (
            <g key={index}>
              {segment.length > 1 && (
                <path
                  d={`${segment.map((point, i) => `${i === 0 ? "M" : "L"}${x(point.time)},${y(point[field])}`).join(" ")} L${x(segment.at(-1)!.time)},${y(0)} L${x(segment[0].time)},${y(0)} Z`}
                  fill={color}
                  opacity="0.06"
                />
              )}
              <path
                d={segment
                  .map(
                    (point, i) =>
                      `${i === 0 ? "M" : "L"}${x(point.time)},${y(point[field])}`,
                  )
                  .join(" ")}
                fill="none"
                stroke={color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {segment.length === 1 && (
                <circle
                  cx={x(segment[0].time)}
                  cy={y(segment[0][field])}
                  r="3"
                  fill={color}
                />
              )}
            </g>
          ))}
          {hover && (
            <>
              <line
                x1={x(hover.time)}
                x2={x(hover.time)}
                y1="0"
                y2={height}
                stroke={color}
                opacity="0.25"
                strokeDasharray="4 4"
              />
              <circle
                cx={x(hover.time)}
                cy={y(hover[field])}
                r="4"
                fill={color}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            </>
          )}
        </svg>
        {!points.length && <span className="chart-empty">暂无历史数据</span>}
      </div>
      <div className="chart-x-labels">
        <span>{dateTime(start)}</span>
        <span>{dateTime(end)}</span>
      </div>
    </div>
  );
}

function Detail({
  server,
  now,
  onClose,
  onUnauthorized,
  onManage,
  onRename,
}: {
  server: ServerSnapshot;
  now: number;
  onClose: () => void;
  onUnauthorized: () => void;
  onManage: () => void;
  onRename: () => void;
}) {
  const [range, setRange] = useState<"1h" | "24h" | "7d">("24h");
  const [history, setHistory] = useState<{
    points: HistoryPoint[];
    step: number;
    generatedAt: number;
  } | null>(null);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusables = [
          ...document.querySelectorAll<HTMLElement>(
            ".detail-dialog button, .detail-dialog a",
          ),
        ];
        const first = focusables[0],
          last = focusables.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", key);
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      try {
        const data = await api<{
          points: HistoryPoint[];
          step: number;
          generatedAt: number;
        }>(`/api/servers/${server.id}/history?range=${range}`, {
          signal: controller.signal,
        });
        setHistory(data);
        setError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onUnauthorized();
        else setError("历史数据暂时无法读取");
      }
    }
    setHistory(null);
    setError("");
    void refresh();
    const interval = setInterval(() => void refresh(), 60000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [server.id, range]);
  const report = server.report;
  const end = history?.generatedAt || now;
  const start = end - { "1h": 3600, "24h": 86400, "7d": 604800 }[range];
  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
      >
        <div className="detail-top">
          <div>
            <span className="eyebrow">服务器指标</span>
            <h2 id="detail-title">
              <span className="detail-name">{server.name}</span>
              <button
                className="secondary-button rename-server-button"
                onClick={onRename}
              >
                <Pencil size={14} />
                重命名
              </button>
              <Badge state={serverState(server, now)} />
            </h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            aria-label="关闭详情"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="detail-facts">
          <span>{report?.os || "—"}</span>
          <span>
            {report
              ? `${report.cpu.cores} 核 · ${bytes(report.memory.totalBytes)} 内存`
              : "—"}
          </span>
          <span>最后上报 {age(server.lastSeen, now)}</span>
        </div>
        <ServerNetwork server={server} />
        <div className="detail-overview">
          <Meter
            label="CPU"
            icon={Cpu}
            value={report?.cpu.usagePercent}
            caption={
              report
                ? `负载 ${report.cpu.load1.toFixed(2)} / ${report.cpu.load5.toFixed(2)} / ${report.cpu.load15.toFixed(2)}`
                : undefined
            }
          />
          <Meter
            label="内存"
            icon={MemoryStick}
            value={report?.memory.usagePercent}
            caption={
              report
                ? `${bytes(report.memory.usedBytes)} / ${bytes(report.memory.totalBytes)}`
                : undefined
            }
          />
          <Meter
            label="磁盘"
            icon={HardDrive}
            value={report ? maxDiskUsage(report) : undefined}
            caption={
              report ? `运行 ${duration(report.uptimeSeconds)}` : undefined
            }
          />
        </div>
        <div className="history-top">
          <h3>历史趋势</h3>
          <div className="segmented">
            {(["1h", "24h", "7d"] as const).map((value) => (
              <button
                key={value}
                className={range === value ? "selected" : ""}
                onClick={() => setRange(value)}
              >
                {{ "1h": "1 小时", "24h": "24 小时", "7d": "7 天" }[value]}
              </button>
            ))}
          </div>
        </div>
        {error ? (
          <p className="inline-error" role="alert">
            {error}
          </p>
        ) : !history ? (
          <div className="history-loading">
            <LoaderCircle className="spin" size={22} />
          </div>
        ) : (
          <div className="charts">
            <Chart
              points={history.points}
              field="cpu"
              label="CPU"
              color="#3874ed"
              step={history.step}
              start={start}
              end={end}
            />
            <Chart
              points={history.points}
              field="memory"
              label="内存"
              color="#9064d8"
              step={history.step}
              start={start}
              end={end}
            />
            <Chart
              points={history.points}
              field="disk"
              label="最高磁盘占用"
              color="#18a48d"
              step={history.step}
              start={start}
              end={end}
            />
          </div>
        )}
        <div className="disk-section">
          <h3>磁盘挂载点</h3>
          {report ? (
            report.disks.map((disk) => (
              <div className="disk-row" key={disk.mount}>
                <div>
                  <strong className="mono">{disk.mount}</strong>
                  <span>
                    {disk.filesystem} · {disk.device}
                  </span>
                </div>
                <div>
                  <strong
                    className={
                      disk.usagePercent >= (server.warningPercent ?? 90)
                        ? "danger-text"
                        : ""
                    }
                  >
                    {percent(disk.usagePercent)}
                  </strong>
                  <span>
                    {bytes(disk.usedBytes)} / {bytes(disk.totalBytes)}
                  </span>
                </div>
                <div
                  className={`disk-bar ${disk.usagePercent >= (server.warningPercent ?? 90) ? "high" : ""}`}
                >
                  <div style={{ width: `${disk.usagePercent}%` }} />
                </div>
              </div>
            ))
          ) : (
            <p className="muted">等待首次上报</p>
          )}
        </div>
        <button
          className="secondary-button manage-server-button"
          onClick={onManage}
        >
          <SettingsIcon size={15} />
          管理服务器
        </button>
        {report && (
          <div className="detail-system">
            <span>{report.architecture}</span>
            <span className="mono">{report.kernel}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Dashboard({
  onUnauthorized,
  onSettings,
}: {
  onUnauthorized: () => void;
  onSettings: (settings: Settings) => void;
}) {
  const [managing, setManaging] = useState<ServerSnapshot | null | undefined>(
    undefined,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [renaming, setRenaming] = useState<ServerSnapshot | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string | null>(null);
  const fetching = useRef(false);
  const now = clock / 1000 + offset;
  async function refresh() {
    if (fetching.current) return;
    fetching.current = true;
    setRefreshing(true);
    try {
      const overview = await api<Overview>("/api/overview");
      setData(overview);
      onSettings(overview.settings);
      setOffset(overview.generatedAt - Date.now() / 1000);
      setError("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else setError(error instanceof Error ? error.message : "无法刷新数据");
    } finally {
      fetching.current = false;
      setRefreshing(false);
    }
  }
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    const clockInterval = setInterval(() => setClock(Date.now()), 1000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      clearInterval(clockInterval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const servers = data?.servers || [];
  const counts = { online: 0, warning: 0, offline: 0, pending: 0, disabled: 0 };
  servers.forEach((server) => counts[serverState(server, now)]++);
  const abnormal = counts.warning + counts.offline;
  const filtered = servers
    .filter(
      (server) =>
        (!search ||
          `${server.name} ${server.report?.os || ""} ${server.network?.ip || ""} ${server.network?.country || ""} ${locationName(server.network)}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (filter === "all" ||
          (filter === "online"
            ? serverState(server, now) === "online"
            : ["warning", "offline"].includes(serverState(server, now)))),
    )
    .sort(
      (a, b) =>
        ({ offline: 0, warning: 1, pending: 2, online: 3, disabled: 4 })[
          serverState(a, now)
        ] -
        { offline: 0, warning: 1, pending: 2, online: 3, disabled: 4 }[
          serverState(b, now)
        ],
    );
  const selectedServer = servers.find((server) => server.id === selected);
  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
      onUnauthorized();
    } catch {
      setError("退出失败，请重试");
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="sidebar-label">监控</div>
        <button
          className="nav-item active"
          onClick={() => {
            setSearch("");
            setFilter("all");
          }}
        >
          <Server size={18} />
          <span>服务器</span>
          <span className="nav-count">{servers.length || "—"}</span>
        </button>
        <button
          className="nav-item settings-nav"
          aria-label="设置"
          onClick={() => setShowSettings(true)}
        >
          <SettingsIcon size={18} />
          <span>设置</span>
        </button>
        <div className="sidebar-bottom">
          <span>
            <LockKeyhole size={14} />
            私人面板
          </span>
          <button
            onClick={() => void logout()}
            className="icon-button"
            aria-label="退出登录"
            title="退出登录"
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div className="breadcrumb">
            监控
            <ChevronRight size={13} />
            <span>服务器</span>
          </div>
          <div className="header-right">
            <span className="refresh-note">
              <i />每 30 秒刷新
            </span>
            <button
              className="icon-button"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="刷新指标"
              title="刷新指标"
            >
              <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            </button>
          </div>
        </header>
        <div className="page-body">
          <div className="page-heading">
            <div>
              <h1>服务器</h1>
              <p>
                {new Date(clock + offset * 1000).toLocaleDateString("zh-CN", {
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                })}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="primary-button add-server-button"
                onClick={() => setManaging(null)}
              >
                <Plus size={16} />
                添加服务器
              </button>
              <span
                className={`overall-state ${abnormal ? "attention" : counts.pending === servers.length ? "neutral" : ""}`}
              >
                {abnormal ? <Activity size={16} /> : <Check size={16} />}
                {!data
                  ? "读取中"
                  : abnormal
                    ? `${abnormal} 台需要关注`
                    : !servers.length
                      ? "暂无服务器"
                      : counts.pending === servers.length
                        ? "等待首次上报"
                        : "指标正常"}
              </span>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>
                {error}
                {data && " · 显示最后一次数据"}
              </span>
              <button onClick={() => void refresh()}>重试</button>
            </div>
          )}
          <div className="summary-grid">
            <div className="summary-card">
              <span className="summary-icon blue">
                <Server size={19} />
              </span>
              <div>
                <span>服务器</span>
                <strong>
                  {data ? servers.length : "—"}
                  <small>台</small>
                </strong>
              </div>
            </div>
            <div className="summary-card">
              <span className="summary-icon green">
                <Check size={19} />
              </span>
              <div>
                <span>在线</span>
                <strong>
                  {data ? counts.online + counts.warning : "—"}
                  <small>台</small>
                </strong>
              </div>
            </div>
            <div className="summary-card">
              <span className={`summary-icon ${abnormal ? "orange" : "gray"}`}>
                <Activity size={19} />
              </span>
              <div>
                <span>需要关注</span>
                <strong>
                  {data ? abnormal : "—"}
                  <small>台</small>
                </strong>
              </div>
            </div>
            <div className="summary-card">
              <span className="summary-icon gray">
                <Clock3 size={19} />
              </span>
              <div>
                <span>等待上报</span>
                <strong>
                  {data ? counts.pending : "—"}
                  <small>台</small>
                </strong>
              </div>
            </div>
          </div>
          <div className="toolbar">
            <div className="filter-tabs">
              {[
                ["all", "全部"],
                ["online", "正常"],
                ["abnormal", "异常"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={filter === key ? "active" : ""}
                  onClick={() => setFilter(key)}
                >
                  {label}
                  <span>
                    {key === "all"
                      ? servers.length
                      : key === "online"
                        ? counts.online
                        : abnormal}
                  </span>
                </button>
              ))}
            </div>
            <div className="toolbar-right">
              <div className="search-box">
                <Search size={15} />
                <input
                  aria-label="搜索服务器"
                  placeholder="搜索名称、IP、位置"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button aria-label="清除搜索" onClick={() => setSearch("")}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="view-toggle">
                <button
                  className={view === "grid" ? "active" : ""}
                  onClick={() => setView("grid")}
                  aria-label="卡片视图"
                  aria-pressed={view === "grid"}
                >
                  <LayoutGrid size={16} />
                </button>
                <button
                  className={view === "list" ? "active" : ""}
                  onClick={() => setView("list")}
                  aria-label="列表视图"
                  aria-pressed={view === "list"}
                >
                  <List size={18} />
                </button>
              </div>
            </div>
          </div>
          {!data && !error ? (
            <div className="loading-state">
              <LoaderCircle size={23} className="spin" />
              <span>读取指标</span>
            </div>
          ) : !filtered.length ? (
            <div className="empty-state">
              <Server size={28} />
              <p>
                {error && !data
                  ? "暂时无法读取指标"
                  : !servers.length
                    ? "还没有服务器"
                    : "没有符合条件的服务器"}
              </p>
              {data && !servers.length && (
                <button
                  className="primary-button"
                  onClick={() => setManaging(null)}
                >
                  <Plus size={16} />
                  添加服务器
                </button>
              )}
            </div>
          ) : view === "grid" ? (
            <div className="server-grid">
              {filtered.map((server) => (
                <ServerCard
                  server={server}
                  key={server.id}
                  now={now}
                  onOpen={() => setSelected(server.id)}
                />
              ))}
            </div>
          ) : (
            <div className="server-table">
              <div className="table-head">
                <span>服务器</span>
                <span>IP / 位置</span>
                <span>状态</span>
                <span>CPU</span>
                <span>内存</span>
                <span>磁盘</span>
                <span>最后上报</span>
              </div>
              {filtered.map((server) => (
                <button
                  className="table-row"
                  key={server.id}
                  onClick={() => setSelected(server.id)}
                >
                  <span className="table-name">
                    <Server size={17} />
                    <strong>{server.name}</strong>
                  </span>
                  <ServerNetwork server={server} />
                  <span>
                    <Badge state={serverState(server, now)} />
                  </span>
                  <span>
                    {server.report
                      ? percent(server.report.cpu.usagePercent)
                      : "—"}
                  </span>
                  <span>
                    {server.report
                      ? percent(server.report.memory.usagePercent)
                      : "—"}
                  </span>
                  <span>
                    {server.report ? percent(maxDiskUsage(server.report)) : "—"}
                  </span>
                  <span>{age(server.lastSeen, now)}</span>
                </button>
              ))}
            </div>
          )}
          <footer className="page-footer">
            <span>
              <i />
              {data?.settings.retentionDays ?? 7} 天历史
            </span>
            <span>
              {data
                ? `更新于 ${new Date(data.generatedAt * 1000).toLocaleTimeString("zh-CN", { hour12: false })}`
                : "—"}
            </span>
          </footer>
        </div>
      </main>
      {selectedServer && !renaming && (
        <Detail
          server={selectedServer}
          now={now}
          onClose={() => setSelected(null)}
          onUnauthorized={onUnauthorized}
          onRename={() => setRenaming(selectedServer)}
          onManage={() => {
            setManaging(selectedServer);
            setSelected(null);
          }}
        />
      )}
      {renaming && (
        <RenameServerDialog
          server={renaming}
          onClose={() => setRenaming(null)}
          onSaved={(name) => {
            setData(
              (current) =>
                current && {
                  ...current,
                  servers: current.servers.map((server) =>
                    server.id === renaming.id ? { ...server, name } : server,
                  ),
                },
            );
            setRenaming(null);
            void refresh();
          }}
          onUnauthorized={onUnauthorized}
        />
      )}
      {managing !== undefined && (
        <ServerManager
          server={managing}
          onClose={() => setManaging(undefined)}
          onSaved={() => void refresh()}
          onUnauthorized={onUnauthorized}
        />
      )}
      {showSettings && (
        <SettingsDialog
          initial={data?.settings || DEFAULT_SETTINGS}
          onClose={() => setShowSettings(false)}
          onSaved={() => void refresh()}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<
    "loading" | "authenticated" | "anonymous" | "error"
  >("loading");
  const [preferences, setPreferences] = useState(DEFAULT_SETTINGS);
  const [setupRequired, setSetupRequired] = useState(false);
  async function checkSession() {
    setSession("loading");
    try {
      const data = await api<{
        authenticated: boolean;
        setupRequired: boolean;
        siteName: string;
      }>("/api/session");
      setPreferences((value) => ({ ...value, siteName: data.siteName }));
      setSetupRequired(data.setupRequired);
      setSession(data.authenticated ? "authenticated" : "anonymous");
    } catch {
      setSession("error");
    }
  }
  useEffect(() => {
    void checkSession();
  }, []);
  useEffect(() => {
    document.title = preferences.siteName;
  }, [preferences.siteName]);
  let content;
  if (session === "loading")
    content = (
      <div className="app-loading">
        <Activity size={28} className="pulse" />
      </div>
    );
  else if (session === "error")
    content = (
      <div className="app-loading">
        <p>暂时无法连接面板</p>
        <button className="primary-button" onClick={() => void checkSession()}>
          重试
        </button>
      </div>
    );
  else if (session === "anonymous")
    content = (
      <Login
        setupRequired={setupRequired}
        onLogin={() => void checkSession()}
      />
    );
  else
    content = (
      <Dashboard
        onSettings={setPreferences}
        onUnauthorized={() => void checkSession()}
      />
    );
  return (
    <BrandContext.Provider value={preferences.siteName}>
      <WarningContext.Provider value={preferences.warningPercent}>
        {content}
      </WarningContext.Provider>
    </BrandContext.Provider>
  );
}
