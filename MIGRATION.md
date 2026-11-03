# 实时与历史数据迁移

实时状态通过 Durable Object 广播，历史指标通过 Analytics Engine 写入和查询。D1 只处理配置、认证、状态变化和迁移记录；旧历史保留只读，不清空数据库。

## 当前链路

- Agent 用 Python 标准库实现持久 WSS；默认 5 秒采样，配置范围 2–10 秒。连接时通过 Authorization 头认证，URL 不含 Token。服务器 ID 通过 X-Server-Id 头绑定；随后每条消息必须匹配该 ID。
- `/api/agent/connect`、`/api/live`（管理员 Cookie + 同源）、`/api/public/live`（公开投影 + 同源）由 Worker 转发至单个 RealtimeHub。
- Hub 使用 WebSocket Hibernation API；连接附件只保存身份摘要、网络来源和会话到期时间。最新 report、collectedAt、receivedAt、lastSeen 和聚合桶只存内存。每个实时样本均不更新 D1/DO Storage。DO Storage 只保存一个检查 alarm。
- 首次浏览器连接收到完整快照，后续按服务器更新；公开增量仅含投影和数组位置，不含内部 ID。服务器增删、排序、位置变化导致排序改变时重发完整快照。
- 管理配置、注册和凭据变更后刷新 Hub 配置，立即关闭被撤销的 Agent；密码变更和退出关闭管理员连接。会话到期由 alarm 关闭。
- 约两次采集周期未更新显示“数据陈旧”；离线阈值 `max(interval_seconds × 3, 15)`，alarm 每 5 秒检查，最晚在阈值后 5 秒确认。短暂重连只替换连接，不生成故障事件。
- D1 的 monitor_presence / monitor_events 只记录在线变化；uptime_intervals 只记录关闭的在线区间，正在进行的在线区间由 Hub 投影。保留原有 90 天 Uptime，不推断未知日期。
- Hub 重建后不恢复实时 payload，已有在线节点进入等待数据状态；下一次报告自动恢复，不重复写在线事件。无后续报告时给予一个超时窗口后转离线。重启时最后心跳无法从内存恢复，因此该窗口内的故障边界存在最多一个超时窗口的误差。
- 历史平均 CPU、平均内存、最大磁盘占用及样本数合成一个 Analytics Engine 数据点。4 台节点时每台每 30 秒写一次；未完成的内存桶和待发送队列在 Hub 重建时丢失，曲线允许缺口。同步写入失败最多暂存每台 10 个桶重试，不回退写 D1。
- 私人历史接口通过 Hub 调用 Analytics Engine SQL API，查询在实时处理队列之外运行，超时不阻塞广播。按样本数及 `_sample_interval` 加权计算 CPU、内存，磁盘取最大值。只接受固定范围及合法服务器 ID，最多返回 700 个图表点，SQL 超时 8 秒。
- 查询按服务器和时间范围在 Hub 内缓存并合并并发请求。4 台节点时共享缓存 150 秒；历史图表仍使用 5 分钟/15 分钟显示粒度，实时卡片不受历史缓存影响。查询失败返回 503，不以空图表伪装成功。

## 预算与索引

当前 4 台节点已使用 5 秒实时协议。以下为设计预算，实际账户额度和其他应用用量仍以 Cloudflare 为准。

- AE 写入周期为 `max(30, ceil(节点数 × 86400 / 80000 / 30) × 30)` 秒，节点数增加时自动扩大。4 台每天约 11,520 点，一个点同时包含所有历史指标。
- 查询缓存为 `max(60, ceil(服务器数 × 3 × 86400 / 8000 / 30) × 30)` 秒，按三个时间范围全部持续读取估算每天不超过 8,000 次查询；首次验证、重启、管理变更及失败重试另占少量请求。这是单实例预算，不是整个账号的硬限流。
- metrics 是 WITHOUT ROWID 表，以 `(server_id, minute)` 为主键，另有 `metrics_by_minute(minute)`；原来一条新历史行对应约 2 rows_written，过期删除也维护该索引。
- snapshots 是普通 rowid 表，TEXT PRIMARY KEY(server_id) 有隐式唯一索引；原 UPSERT 还触发 uptime_tracking / uptime_intervals，后者另有 uptime_by_end(ended_at)。触发器与索引共同导致额外写入。
- 保留全部旧表、数据、索引和触发器，不进行清空、DROP 或历史回填。采集链路的 INSERT snapshots / INSERT metrics 和定期 DELETE metrics 均停止；管理员明确删除服务器时仍删除对应旧行以满足外键约束。状态变化和认证清理仍产生少量 D1 写入。

## 发布和 Agent 升级

1. 配置下述 Analytics Engine 运行时 Secret，运行 `npm run verify`、`npm run test:integration`。提交并推送 main，由现有 Workers Builds 执行 D1 增量迁移和部署；禁止本地直接发布 Worker。
2. 仅使用 `https://status.9ba.in` 验证。自定义域名保留，workers.dev 和 preview URL 均关闭。
3. 旧 `/api/ingest` 保持兼容，接入同一个 Hub，不写 snapshots 或 metrics；旧 Agent 的 60 秒周期在升级前保持。此时旧节点还不能满足 5 秒采样目标。
4. 尚未升级的服务器以维护入口执行以下安装器更新，无需新 Token、无需重新注册：

   ```sh
   curl -fsS https://status.9ba.in/agent/install.sh | sh -s -- --url https://status.9ba.in --update
   ```

   安装器保留 `/etc/status-agent/config.json` 的服务器 ID 与 Token。新 Agent 仍兼容配置中的 `/api/ingest` endpoint，但运行时连接同源 `/api/agent/connect`。首次 WSS 连接把旧的 30–3600 秒服务器配置改为 5 秒，只产生一次配置写入。

5. `systemctl status status-agent` 确认运行。在 `/admin` 观察连续报告的 lastSeen 相差约 5 秒；关闭再启动 Agent，确认只产生一次离线/恢复事件。
6. 全部 Agent 迁移并稳定运行后才能另行移除 HTTP 接口；本次保留。本阶段只改服务端，已升级的 Agent 无需再更新。
7. Insights 以部署之后的时间窗核验采集链路的 INSERT snapshots / INSERT metrics / 定期 DELETE metrics 均为 0。全天统计仍包含发布前的写入。

## Analytics Engine 配置与验收

运行时需专用、限目标账号的 **Account Analytics:Read** Token，保存为 Worker Secret `AE_QUERY_TOKEN`。写入使用 `HISTORY` 绑定，不使用该 Token。不复制本机开发凭据，不向浏览器返回 Cloudflare 凭据。

1. 部署脚本同时设置写入 dataset 和查询变量 `AE_DATASET`，默认由 Worker 名称生成；本实例为 `status_9ba_in_metrics`。`AE_ACCOUNT_ID` 来自部署账号。可用构建变量 `STATUS_HISTORY_DATASET` 覆盖，但启用后应保持名称稳定。
2. 迁移 `0006` 只增加 `history_migration`。Hub 首次启动保存切换时间，重启继续使用该时间。旧 D1 仅查询切换前数据，AE 查询切换后的数据；图表边界桶重合时以 AE 为准，避免重复。
3. AE 每点 indexes=[server_id]、blobs=[v1]，doubles 顺序为平均 CPU、平均内存、最大磁盘占用、样本数、桶开始秒、桶结束秒。没有主机名、IP、Token 或原始 payload。
4. 首次写入后，Hub 用同一历史 SQL 在服务端探测查询，读到数据才在 `history_migration` 写一次 `verified_at` / `verified_points`。验收应检查这两个值、实际历史接口和连续实时广播；本地 SQL fixture 不代表线上写入成功。
5. 应用保留设置只限制历史查询窗口（1–30 天）。AE 由平台保留约 3 个月，应用不逐条删除；管理员删除服务器后历史接口不可再访问，AE 点由平台到期清理。旧 D1 历史物理保留用于回滚，不再定期删除，超出窗口的旧行不返回。

## 回滚

历史迁移回滚时，通过新 Git 提交恢复第一阶段的 5 分钟 D1 聚合与历史读取，再由 Workers Builds 发布；实时协议不变，无需降级 Agent。AE 时段保留在平台，回滚的 D1 图表会有对应缺口；再次迁往 AE 时需明确新的切换边界，不能直接复用旧记录而忽略回滚期间的 D1 数据。保留 dataset、Secret、D1 迁移表及 Durable Object 声明，不重写已发布 Git 历史，不清空旧数据。若回滚到更早的 HTTP-only 版本，则必须同时规划 Agent 降级；不建议作为常规回滚。
