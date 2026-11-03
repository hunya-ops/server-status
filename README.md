# Server Status

服务器监控面板，使用 Cloudflare Workers + D1。首页为公开 Uptime 页面，私人管理面板位于 `/admin`。每个人独立部署自己的实例，Linux agent 通过持久 WSS 主动上报，无需开放监控端口。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hunya-ops/server-status)

## 部署自己的面板

1. 点击上方按钮，登录 Cloudflare 并授权 GitHub/GitLab。向导会复制公开模板到你的账号，创建 Worker 和 D1，并连接 Workers Builds。它创建的是新的仓库；如果希望保留 GitHub Fork 关系，先 Fork，再在 Cloudflare 连接自己的仓库。
2. 设置运行时 Secret `SETUP_KEY`：使用自己生成的、至少 32 字符的随机密钥，不使用示例值。它用于首次初始化和会话签名，初始化后仍须保留。Cloudflare API Token 不属于面板运行时配置。
3. 确认构建命令 `npm run build`，部署命令 `npm run deploy`，生产分支 `main`。部署自动执行 D1 迁移，新数据库不会添加示例服务器。
4. 部署前通过 `STATUS_DOMAIN` 配置自己的域名，或在 Worker 的 Settings → Domains & Routes 中绑定 Custom Domain。默认 workers.dev 与预览地址均关闭。
5. 访问 `/admin`，填写 `SETUP_KEY` 并设置访问密码（至少 12 个字符）。初始化只能完成一次，之后使用访问密码登录。用户名固定为 `admin`，便于密码管理器保存和自动填充。管理面板需要登录。

官方按钮需要公开的源仓库，并能自动创建 D1；资源 ID 在部署者自己的副本中更新。首次部署前声明 Secrets 的示例文件为 `.dev.vars.example`。参见 [Deploy to Cloudflare 文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

后续发布只需推送自己的部署分支，由 Workers Builds 自动部署。模板的真实部署脚本仅允许在 CI 中运行；本地检查使用 `npm run deploy:check`。

### 域名

使用自定义域名。自动部署保留已绑定域名和路由，并关闭 workers.dev 与 preview URL。修改域名时须同步修改 Agent 配置中的 endpoint，保留服务器 ID 和 Token，再重启服务。

## 一键接入服务器

访问 `/admin` 并登录 → 添加服务器 → 复制安装命令 → 在目标 Linux 服务器执行。root 可直接运行，普通用户会通过 sudo 提权。

命令形态如下；实际域名、服务器 ID 和接入码由面板自动填写：

```sh
curl -fsS 'https://status.example.com'/agent/install.sh | sh -s -- \
  --url 'https://status.example.com' --server SERVER_ID --enroll ENROLLMENT_CODE
```

安装程序支持 Linux + systemd，会安装缺少的 Python 3/curl、校验下载文件、登记服务器凭证、验证首次上报，并启用开机启动。采集程序只使用 Python 标准库。常见 apt、dnf、yum 系统可自动安装依赖；其他系统需预先安装 Python 3、curl 和 CA 证书。

- 接入码有效期 10 分钟，只能登记一份凭证；同一凭证的重试可恢复网络中断造成的响应丢失。新生成的命令会使旧接入码失效。
- 同一台主机重复执行已完成的安装命令会复用本机凭证并更新程序，无需再次登记；新生成的命令用于重新接入。
- 长期采集凭证在服务器本地随机生成，数据库只保存摘要。接入码不是面板密码，也不能读取指标。
- 重新接入成功后，旧凭证失效。面板支持改名、排序、修改采集间隔、停用、立即撤销凭证和删除服务器及历史。
- 在服务器详情标题旁点击“重命名”修改 VPS 名称（1–80 个字符）。名称仅在后台卡片、列表、详情和搜索中使用；公开首页仍按位置展示节点，改名保留采集凭证、设置和历史。
- 配置位于 `/etc/status-agent/config.json`，新安装使用 `root:status-agent` 的 `640` 权限，采集用户只能读取。每台主机支持安装一个实例。
- 安装文件随面板构建分发，通过版本目录及 SHA-256 清单校验。校验失败不会替换运行程序；服务启动失败时尝试恢复旧程序。

更新 agent（保留 ID 和凭证）：

```sh
curl -fsS https://status.example.com/agent/install.sh | sh -s -- \
  --url https://status.example.com --update
```

卸载 agent：

```sh
curl -fsS https://status.example.com/agent/install.sh | sh -s -- --url https://status.example.com --uninstall
```

查看状态与日志：

```sh
systemctl status status-agent
journalctl -u status-agent -n 20 --no-pager
```

## 指标与访问控制

- `/` 公开显示已启用服务器的国家/城市、采集状态、最近 90 天 Uptime，以及 CPU 核数、内存和磁盘总容量。磁盘容量汇总采集到的真实挂载点。按国家、再按城市排序，位置未知的节点排在最后；相同位置按后台顺序编号，位置缺失时显示“位置未知”；停用的服务器不公开。公开接口 `/api/public/uptime` 只返回这些摘要，不返回服务器名称、内部 ID、IP、主机名、挂载路径、凭证或其他系统指标。
- 公开 Uptime 按采集心跳统计：在线超时为三倍采集间隔（至少 15 秒），只在状态变化时保存区间，缺失部分计为中断。按 UTC 日期展示，比例只计算首次记录以后已经过的时间；未记录日期为灰色。它反映采集持续性，不代表外部服务可达性。
- Uptime 历史从升级后的首次有效上报开始积累，不从旧的指标反推在线记录。独立保留 90 个日历日，不受私人指标的 1–30 天保留设置影响。
- CPU、核心数、系统负载、内存、真实磁盘挂载点及系统运行时间。
- 卡片、列表和详情显示上报出口 IP、国旗和城市，支持按 IP 或位置搜索。地址和位置来自 Cloudflare 的上报请求信息，无需更新 agent 或接入第三方 IP 查询服务；下一次有效上报后自动显示。位置由 IP 估算，可能与机房所在地不同；使用 NAT 或代理时显示出口地址，城市缺失时显示国家，位置未知时明确标注。详见 [Cloudflare 请求地理信息](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)。
- 卡片/列表、搜索、状态筛选，以及 1 小时、24 小时和 7 天历史。历史缺失处曲线断开。
- 默认采集间隔 5 秒，可设为 2–10 秒，面板通过 WebSocket 实时更新。两次周期未更新显示数据陈旧，超过三倍周期（至少 15 秒）没有上报显示离线；这表示采集上报中断，不代表服务可达性。
- 历史在内存聚合后每 5 分钟写入一次，默认占用阈值 90%、保留 7 天历史，可在设置中修改。保留天数支持 1–30 天，过期历史每小时清理。查看 7 天曲线时只返回仍在保留范围内的数据。
- 私人面板的指标、历史和管理 API 校验管理员会话，管理写入校验同源。安装文件公开，接入接口只接受有效接入码，采集接口使用独立服务器凭证。
- 管理员密码使用随机盐、PBKDF2 和服务器密钥；会话使用 HttpOnly 签名 Cookie，登录失败限速。修改密码会退出其他会话。
- 拒绝时间偏差超过 120 秒、跨服务器及格式异常的上报；旧数据不能覆盖最新状态。服务器时间应保持同步。

服务可达性监控将在后续版本增加。

## 本地开发

要求 Node.js 22.12+、Python 3。

```sh
npm ci
node scripts/create-credentials.mjs
npm run build
npm run db:local
npm run dev:worker
```

另一终端执行 `npm run dev`。新实例的初始化密钥保存在 `.local/credentials.json`，本地 Secrets 写入 `.dev.vars`；这些文件均忽略提交。浏览器初始化使用其中的 `setupKey`。

```sh
npm run verify
npm run test:integration
```

集成测试在独立本地 D1 中验证公开 Uptime 数据隔离、首页与 `/admin` 路由、空库安装、初始化、服务器管理、接入码、Python 登记程序、凭证隔离、指标历史、密码修改和安装包。不会访问线上数据库。

## 升级已有实例

已有数据库通过迁移记录跳过 `0001_servers.sql`，只应用新增迁移。该初始迁移保留原表结构，移除了仅用于新库的个人服务器种子；不会删除已有记录。升级保留服务器 ID、凭证、快照和历史，协议 v1 的 agent 可以继续上报。

已有实例仍可使用原有 `SESSION_SECRET` 与 `DASHBOARD_PASSWORD_HASH`。升级后第一次密码登录会把管理员凭证迁移到新的密码格式；迁移后旧会话需要重新登录。旧 HTTP Agent 继续可用；要获得 5 秒采样，请使用上文 `--update` 命令升级。详见 [实时链路迁移与回滚](MIGRATION.md)。

已有实例的部署参数可放在 Cloudflare Build variables 中，避免在公共源码中固定任何账号和资源：

| 构建变量               | 用途                           |
| ---------------------- | ------------------------------ |
| `STATUS_WORKER_NAME`   | 已有 Worker 名称               |
| `STATUS_DOMAIN`        | 可选，首次部署时绑定的自有域名 |
| `STATUS_ACCOUNT_ID`    | Cloudflare 账号                |
| `STATUS_DATABASE_ID`   | 已有 D1 ID                     |
| `STATUS_DATABASE_NAME` | 已有 D1 名称                   |

本地开发可把相同参数放入忽略提交的 `.local/deployment.json`，字段为 `name`、`domain`、`accountId`、`databaseId` 和 `databaseName`。这份文件不参与 GitHub 自动构建；线上构建必须使用构建变量。构建变量优先于本地实例配置，Workers Builds 提供的 Worker 名称优先。已有 Worker 的域名设置以控制台为准，`workers.dev` 与 preview URL 始终关闭。生成的 Wrangler 文件位于 `.wrangler/deployment.json`。

部署命令始终通过 `DB` 绑定执行迁移，不依赖数据库名称。Secrets 保存在运行时配置中，构建变量用于部署资源配置，两者用途不同。
