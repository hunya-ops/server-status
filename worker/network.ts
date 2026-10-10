import type { ServerNetwork } from "../shared/types";

function ipAddress(value: string | null): string | null {
  if (!value || value.length > 45) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const octets = value.split(".");
    return octets.every(
      (octet) => Number(octet) <= 255 && String(Number(octet)) === octet,
    )
      ? value
      : null;
  }
  if (!value.includes(":") || !/^[\da-f:.]+$/i.test(value)) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function requestNetwork(request: Request): ServerNetwork | null {
  // Pseudo IPv4 can overwrite CF-Connecting-IP; retain the real IPv6 address.
  const ipv6 = ipAddress(request.headers.get("CF-Connecting-IPv6"));
  const ip =
    (ipv6?.includes(":") ? ipv6 : null) ||
    ipAddress(request.headers.get("CF-Connecting-IP"));
  if (!ip) return null;
  const country = request.cf?.country;
  const city = request.cf?.city;
  return {
    ip,
    country:
      typeof country === "string" &&
      /^[A-Z]{2}$/.test(country) &&
      country !== "XX"
        ? country
        : null,
    city:
      typeof city === "string" &&
      city.trim().length <= 100 &&
      !/[\u0000-\u001f\u007f]/.test(city)
        ? city.trim() || null
        : null,
  };
}
