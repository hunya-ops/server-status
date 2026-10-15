import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Copy, LoaderCircle, X } from "lucide-react";
import { api, ApiError } from "./api";
import { type ServerSnapshot, type Settings } from "../shared/types";

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLElement>("input, button")?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const nodes = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]',
        ) || []),
      ];
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0].focus();
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
      document.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="management-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="management-title"
      >
        <div className="management-heading">
          <h2 id="management-title">{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

interface Installation {
  command: string;
  expiresAt: number;
  id?: string;
  sortOrder?: number;
}

export function RenameServerDialog({
  server,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  server: ServerSnapshot;
  onClose: () => void;
  onSaved: (name: string) => void;
  onUnauthorized: () => void;
}) {
  const [name, setName] = useState(server.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ name: string }>(
        `/api/servers/${server.id}/name`,
        { method: "PATCH", body: JSON.stringify({ name }) },
      );
      onSaved(result.name);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="重命名 VPS" onClose={() => !busy && onClose()}>
      <form className="management-form" onSubmit={save}>
        <label>
          VPS 名称
          <input
            ref={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={80}
            disabled={busy}
            aria-describedby="rename-note"
          />
        </label>
        <p className="field-note" id="rename-note">
          仅在后台显示
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="primary-button"
            disabled={busy || !name.trim() || name.trim() === server.name}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : "保存"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ServerManager({
  server,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  server: ServerSnapshot | null;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const [id, setId] = useState(server?.id);
  const [name, setName] = useState(server?.name || "");
  const [interval, setInterval] = useState(server?.intervalSeconds || 60);
  const [sortOrder, setSortOrder] = useState(server?.sortOrder || 0);
  const [enabled, setEnabled] = useState(server?.enabled !== false);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "revoke" | null>(null);
  const command = useRef<HTMLTextAreaElement>(null);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else setError(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (!id) {
        const result = await api<Installation>("/api/servers", {
          method: "POST",
          body: JSON.stringify({ name, intervalSeconds: interval }),
        });
        setId(result.id);
        setSortOrder(result.sortOrder ?? 0);
        setInstallation(result);
        setCopied(false);
      } else {
        await api(`/api/servers/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            intervalSeconds: interval,
            enabled,
            sortOrder,
          }),
        });
        if (!enabled) setInstallation(null);
      }
      onSaved();
    });
  }
  async function copy() {
    if (!installation) return;
    try {
      await navigator.clipboard.writeText(installation.command);
      setCopied(true);
    } catch {
      command.current?.focus();
      command.current?.select();
      setError("请复制已选中的安装命令");
    }
  }
  return (
    <Dialog title={id ? "管理服务器" : "添加服务器"} onClose={onClose}>
      <form className="management-form" onSubmit={save}>
        <label>
          VPS 名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={80}
            placeholder="例如：应用服务器"
          />
        </label>
        <div className="form-columns">
          <label>
            采集间隔（秒）
            <input
              type="number"
              min={30}
              max={3600}
              value={interval}
              onChange={(event) => setInterval(Number(event.target.value))}
              required
            />
          </label>
          {id && (
            <label>
              排序
              <input
                type="number"
                min={0}
                max={1000000}
                value={sortOrder}
                onChange={(event) => setSortOrder(Number(event.target.value))}
                required
              />
            </label>
          )}
        </div>
        {id && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            启用采集
          </label>
        )}
        <div className="form-actions">
          <button className="primary-button" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : id ? (
              "保存"
            ) : (
              "创建并生成安装命令"
            )}
          </button>
          {id && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setInstallation(
                    await api(`/api/servers/${id}/install`, { method: "POST" }),
                  );
                  setCopied(false);
                })
              }
            >
              生成安装命令
            </button>
          )}
        </div>
      </form>
      {installation && (
        <div className="installation-box">
          <div className="installation-heading">
            <strong>在目标服务器执行</strong>
            <button className="secondary-button" onClick={() => void copy()}>
              <Copy size={14} />
              {copied ? "已复制" : "复制命令"}
            </button>
          </div>
          <textarea
            ref={command}
            className="mono"
            aria-label="安装命令"
            readOnly
            value={installation.command}
            onFocus={(event) => event.target.select()}
          />
          <p className="field-note">
            Linux · systemd · 接入码有效至{" "}
            {new Date(installation.expiresAt * 1000).toLocaleTimeString(
              "zh-CN",
              { hour12: false },
            )}
          </p>
          <p className="field-note">重新接入成功后，原采集凭证失效。</p>
        </div>
      )}
      {id && (
        <div className="danger-actions">
          {confirm ? (
            <div className="confirm-action">
              <p>
                {confirm === "delete"
                  ? "删除服务器及全部历史？"
                  : "立即撤销采集凭证？需要重新安装接入。"}
              </p>
              <div>
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `/api/servers/${id}${confirm === "revoke" ? "/revoke" : ""}`,
                        { method: confirm === "revoke" ? "POST" : "DELETE" },
                      );
                      setInstallation(null);
                      setConfirm(null);
                      onSaved();
                      if (confirm === "delete") onClose();
                    })
                  }
                >
                  确认{confirm === "delete" ? "删除" : "撤销"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setConfirm(null)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => setConfirm("revoke")}
              >
                撤销凭证
              </button>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => setConfirm("delete")}
              >
                删除服务器
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function SettingsDialog({
  initial,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  initial: Settings;
  onClose: () => void;
  onSaved: () => void;
  onUnauthorized: () => void;
}) {
  const [preferences, setPreferences] = useState(initial);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent, changePassword = false) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (changePassword) {
        await api("/api/password", {
          method: "POST",
          body: JSON.stringify({ currentPassword, password }),
        });
        setCurrentPassword("");
        setPassword("");
        setMessage("密码已修改，其他会话已退出");
      } else {
        await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify(preferences),
        });
        setMessage("设置已保存");
        onSaved();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && !changePassword)
        onUnauthorized();
      else setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="面板设置" onClose={onClose}>
      <form
        className="management-form"
        onSubmit={(event) => void submit(event)}
      >
        <label>
          面板名称
          <input
            value={preferences.siteName}
            maxLength={80}
            required
            onChange={(event) =>
              setPreferences({ ...preferences, siteName: event.target.value })
            }
          />
        </label>
        <div className="form-columns">
          <label>
            占用阈值（%）
            <input
              type="number"
              min={1}
              max={100}
              value={preferences.warningPercent}
              required
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  warningPercent: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            历史保留（天）
            <input
              type="number"
              min={1}
              max={30}
              value={preferences.retentionDays}
              required
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  retentionDays: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <p className="field-note">
          缩短保留时间后，过期历史将在下次清理时删除。
        </p>
        <button className="primary-button" disabled={busy}>
          保存设置
        </button>
      </form>
      <form
        className="management-form password-form"
        method="post"
        onSubmit={(event) => void submit(event, true)}
      >
        <h3>修改密码</h3>
        <input
          type="text"
          name="username"
          autoComplete="username"
          value="admin"
          readOnly
          hidden
        />
        <label>
          当前密码
          <input
            name="currentPassword"
            type="password"
            value={currentPassword}
            autoComplete="current-password"
            maxLength={256}
            required
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          新密码
          <input
            name="password"
            type="password"
            value={password}
            autoComplete="new-password"
            minLength={12}
            maxLength={256}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="secondary-button" disabled={busy}>
          修改密码
        </button>
      </form>
      {message && (
        <p className="field-note" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
