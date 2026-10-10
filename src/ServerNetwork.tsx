import type { ServerSnapshot } from "../shared/types";
import { countryFlag, countryName, locationName } from "../shared/location";

export function ServerNetwork({ server }: { server: ServerSnapshot }) {
  const network = server.network;
  const flag = countryFlag(network?.country ?? null);
  return (
    <span
      className="server-network"
      title="服务器上报的出口 IP；位置由 IP 估算"
    >
      <span className="network-ip mono">
        {network?.ip || (server.report ? "IP 未获取" : "等待上报")}
      </span>
      <span className="network-location">
        {flag && (
          <span
            className="country-flag"
            role="img"
            aria-label={countryName(network?.country ?? null)}
          >
            {flag}
          </span>
        )}
        <span>{locationName(network) || "位置未知"}</span>
      </span>
    </span>
  );
}
