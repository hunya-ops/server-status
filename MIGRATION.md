# 实时数据迁移

本次实施第一阶段：秒级实时链路 + D1 每 5 分钟聚合历史。Analytics Engine 的写入与查询为第二阶段，尚未启用；不把本机 Cloudflare 开发 Token 复制到 Worker。

## 当前链路

- Agent 用 Python 标准库实现持久 WSS；默认 5 秒采样，配置范围 2–10 秒。连接时通过 Authorization 头认证，URL 不含 Token。服务器 ID 通过 X-Server-Id 头绑定；随后每条消息必须匹配该 ID。
- `/api/agent/connect`、`/api/live`（管理员 Cookie + 同源）、`/api/public/live`（公开投影 + 同源）由 Worker 转发至单个 RealtimeHub。
- Hub 使用 WebSocket Hibernation API；连接附件只保存身份摘要、网络来源和会话到期时间。最新 report、collectedAt、receivedAt、lastSeen 和聚合桶只存内存。每个实时样本均不更新 D1/DO Storage。DO Storage 只保存一个检查 alarm。
- 首次浏览器连接收到完整快照，后续按服务器更新；公开增量仅含投影和数组位置，不含内部 ID。服务器增删、排序、位置变化导致排序改变时重发完整快照。
- 管理配置、注册和凭据变更后刷新 Hub 配置，立即关闭被撤销的 Agent；密码变更和退出关闭管理员连接。会话到期由 alarm 关闭。
- 约两次采集周期未更新显示“数据陈旧”；离线阈值 `max(interval_seconds × 3, 15)`，alarm 每 5 秒检查，最晚在阈值后 5 秒确认。短暂重连只替换连接，不生成故障事件。
- D1 的 monitor_presence / monitor_events 只记录在线变化；uptime_intervals 只记录关闭的在线区间，正在进行的在线区间由 Hub 投影。保留原有 90 天 Uptime，不推断未知日期。
- Hub 重建后不恢复实时 payload，已有在线节点进入等待数据状态；下一次报告自动恢复，不重复写在线事件。无后续报告时给予一个超时窗口后转离线。重启时最后心跳无法从内存恢复，因此该窗口内的故障边界存在最多一个超时窗口的误差。
- 历史平均 CPU、平均内存、最大磁盘占用合成一行，每台服务器每 300 秒写一次。未完成的内存聚合桶在 Hub 重建时丢失，曲线允许缺口。保留时间内的旧分钟历史仍可查询。

## 写入预算与索引

本次只读核验有 4 台已启用节点，原 interval_seconds 均为 60。

- 历史聚合每节点每天最多 288 行。
- metrics 是 WITHOUT ROWID 表，以 `(server_id, minute)` 为主键，另有 `metrics_by_minute(minute)`；一条新历史行对应约 2 rows_written，过期删除也维护该索引。
- 4 节点预计新增约 2,304 rows_written/日，稳定期清理约 2,304/日，合计约 4,608/日，另加少量状态与管理写入。此估计不是已观测的 Insights 数值，旧分钟数据过期期间清理量仍较高。
- snapshots 是普通 rowid 表，TEXT PRIMARY KEY(server_id) 有隐式唯一索引；原 UPSERT 还触发 uptime_tracking / uptime_intervals，后者另有 uptime_by_end(ended_at)。触发器与索引共同导致额外写入。
- 本次保留全部旧表、数据、索引和触发器，不进行清空、DROP 或历史回填。线上 INSERT snapshots 应立即降为 0；第一阶段仍有低频 INSERT/DELETE metrics。
- 服务器数量增加时需重新核算预算；保守按 1,152 rows_written/节点/日（新增与过期清理）计，预留其他应用额度，超过约 40 台前应完成 AE 迁移。

## 发布和 Agent 升级

1. 运行 `npm run verify`、`npm run test:integration`。提交并推送 main，由现有 Workers Builds 执行 D1 增量迁移和部署；禁止本地直接发布 Worker。
2. 仅使用 `https://status.9ba.in` 验证。自定义域名保留，workers.dev 和 preview URL 均关闭。
3. 旧 `/api/ingest` 保持兼容，接入同一个 Hub，不写 snapshots；旧 Agent 的 60 秒周期在升级前保持。此时旧节点还不能满足 5 秒采样目标。
4. 在每台服务器以维护入口执行以下现有安装器更新（无需新 Token、无需重新注册）：

   ```sh
   curl -fsS https://status.9ba.in/agent/install.sh | sh -s -- --url https://status.9ba.in --update
   ```

   安装器保留 `/etc/status-agent/config.json` 的服务器 ID 与 Token。新 Agent 仍兼容配置中的 `/api/ingest` endpoint，但运行时连接同源 `/api/agent/connect`。首次 WSS 连接把旧的 30–3600 秒服务器配置改为 5 秒，只产生一次配置写入。

5. `systemctl status status-agent` 确认运行。在 `/admin` 观察连续报告的 lastSeen 相差约 5 秒；关闭再启动 Agent，确认只产生一次离线/恢复事件。
6. 全部 Agent 迁移并稳定运行后才能另行移除 HTTP 接口；本次保留。
7. Insights 以部署之后的时间窗核验 INSERT snapshots=0，metrics 约每节点 5 分钟一行。全天统计仍包含发布前的写入。

## 第二阶段：Analytics Engine

前置条件是账号内具备 Analytics Engine 写入可用性，以及专用、限目标账号的 **Account Analytics:Read** 查询 Token（以 Cloudflare 当前权限名称为准）。当前运行时没有该 Secret，开发 Token 读取账号 Token 权限列表返回 403；不因此扩展开发凭据或把它放入 Worker。

1. 添加 `analytics_engine_datasets` 绑定，例如 HISTORY，dataset 使用部署变量配置的独立名称。专用查询 Token 只注入 Worker Secret，不写 Git、不返回浏览器。
2. Hub 将聚合周期改为 10–30 秒；每点 indexes=[server_id]，doubles 包含 CPU、内存、磁盘和样本数。根据节点数计算每日点数，按当时 Cloudflare 免费额度留出余量；超出时扩大聚合周期或明确升级套餐。
3. 服务端历史接口调用账号 Analytics Engine SQL API，限制 range、server ID、行数、超时，并按 `_sample_interval` 和样本数加权聚合。浏览器继续仅访问已认证的 `/api/servers/:id/history`。
4. 先验证双读旧 D1 历史 + AE 新历史（切换时间分界去重），再停止 D1 聚合 INSERT 及定期 DELETE metrics。旧历史不必破坏性导出或删除，保留表作为回滚资料。
5. AE 查询失败明确返回不可用，不能用空历史伪装为成功。确认新历史、隔离、免费额度和回滚后再宣布 INSERT/DELETE metrics=0。

## 回滚

通过新 Git 提交恢复旧实现，由 Workers Builds 发布；不重写已发布 Git 历史。保留已创建的 Durable Object 迁移声明与导出，避免删除有状态命名空间。旧 snapshots 在迁移期间停止更新，回滚后等待旧 HTTP Agent 的下一次上报；新 Agent 在旧服务端不可用时需暂时恢复旧安装包。D1 新表可保留，旧数据不需清空或变更。
