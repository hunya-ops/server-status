# Security

Never commit `.local/`, `.dev.vars`, `.env`, server addresses, passwords, enrollment codes or agent credentials. Keep Cloudflare API credentials outside the project. The example secret file deliberately contains no working defaults.

Private metrics, history and management require an administrator session. Public installation assets contain no instance credentials. Enrollment codes expire after ten minutes, bind to one server and one credential, and are stored only as hashes. An identical registration retry is accepted until expiry so a lost response cannot strand an installation.

The homepage is public; the administrator panel is at `/admin`. `/api/public/uptime` is an explicit public projection for enabled servers: country/city, reported system uptime, heartbeat state, daily uptime percentages, CPU core count, total memory and total disk capacity. Disk capacity sums the real filesystems reported by the agent. It excludes names, server IDs, IP addresses, hostnames, mount paths, device names, credentials and private usage metrics. Public heartbeat history starts with the first accepted report after this feature is installed and is kept separately for 90 calendar days. Missing history is never presented as successful uptime.

Use HTTPS with either the default `workers.dev` domain or your own custom domain. The template enables the production default domain and disables preview URLs. All dashboard authentication applies on either domain. The agent does not forward credentials through redirects.

Password hashing uses native PBKDF2-HMAC-SHA256 with 100,000 iterations, a random salt and a server-side pepper. Cloudflare Workers currently caps native PBKDF2 calls at 100,000 iterations; the salt and digest alone are insufficient to verify guesses without the runtime secret. Changing the runtime secret invalidates stored passwords as well as sessions. Keep it backed up privately. See the [upstream runtime limit](https://github.com/cloudflare/workerd/pull/7550).

If the setup key or server secret is lost, recovery requires resetting the singleton `administrator` row through the account's D1 administration tools and configuring a new private setup key. This invalidates access and requires setting a new password; it does not delete metrics. Do not provide an unauthenticated reset endpoint.

A public repository must also have sanitized history. Replacing current files does not remove data from old commits, pull requests, releases, forks or cached GitHub views. Rotate any exposed credentials before publishing. Share security reports privately with the repository maintainers and omit credentials from public issues.
