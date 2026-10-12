# 项目约定

- 第一阶段只监控服务器指标，服务可达性监控后续增加。
- 私人面板，所有指标和历史 API 都必须经过认证。采集接口使用独立的服务器凭证。
- 首页为公开 Uptime，私人面板位于 `/admin`；公开接口仅允许地理位置、采集状态和 Uptime 摘要，不公开 VPS 名称、内部 ID、IP、主机名及其他指标。未记录日期不能显示为正常。
- 代码提交并推送至 GitHub，由 Cloudflare Workers Builds 自动构建部署。禁止在本地直接发布 Worker。
- UI 验证使用 Codex 内置浏览器。文案保持简洁。
- 运行 `npm run verify` 和 `npm run test:integration` 验证修改。采集程序使用 Python 标准库。
- 凭证和服务器 IP 不提交到仓库；本地部署资料放在已忽略的 `.local/`。
