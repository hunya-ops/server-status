import { describe, expect, it } from "vitest";
import { requestNetwork } from "../worker/network";
import { countryFlag, countryName, locationName } from "../shared/location";

function request(
  headers: Record<string, string> = {},
  cf?: Record<string, unknown>,
) {
  const request = new Request("https://status.example.com/api/ingest", {
    headers,
  });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
}

describe("server connection metadata", () => {
  it("uses the ingest connection and Cloudflare location, ignoring forwarded geo headers", () => {
    expect(
      requestNetwork(
        request(
          {
            "CF-Connecting-IP": "192.0.2.10",
            "X-Forwarded-For": "198.51.100.10",
            "CF-IPCountry": "US",
          },
          { country: "JP", city: " Tokyo " },
        ),
      ),
    ).toEqual({
      ip: "192.0.2.10",
      country: "JP",
      city: "Tokyo",
    });
  });

  it("retains the real IPv6 address when Pseudo IPv4 overwrites the connecting IP", () => {
    expect(
      requestNetwork(
        request(
          {
            "CF-Connecting-IP": "240.0.2.1",
            "CF-Connecting-IPv6": "2001:0DB8:0000:0000:0000:0000:0000:0010",
          },
          { country: "SG", city: "Singapore" },
        ),
      )?.ip,
    ).toBe("2001:db8::10");
    expect(
      requestNetwork(
        request({
          "CF-Connecting-IP": "192.0.2.10",
          "CF-Connecting-IPv6": "invalid",
        }),
      )?.ip,
    ).toBe("192.0.2.10");
  });

  it("does not invent an IP or location when metadata is unavailable", () => {
    expect(
      requestNetwork(
        request({ "X-Forwarded-For": "192.0.2.10" }, { country: "JP" }),
      ),
    ).toBeNull();
    expect(
      requestNetwork(request({ "CF-Connecting-IP": "2001:db8::10" })),
    ).toEqual({
      ip: "2001:db8::10",
      country: null,
      city: null,
    });
  });

  it.each([
    "999.0.2.1",
    "192.0.2.01",
    "192.0.2.1:443",
    "2001:::10",
    "example.com",
    "192.0.2.1, 198.51.100.1",
    "::1%lo0",
  ])("rejects malformed connection addresses (%s)", (ip) => {
    expect(requestNetwork(request({ "CF-Connecting-IP": ip }))).toBeNull();
  });

  it.each(["XX", "T1", "USA", ""])(
    "handles unknown country markers (%s)",
    (country) => {
      expect(
        requestNetwork(
          request({ "CF-Connecting-IP": "192.0.2.10" }, { country, city: "" }),
        ),
      ).toEqual({
        ip: "192.0.2.10",
        country: null,
        city: null,
      });
    },
  );
});

describe("network labels", () => {
  it("shows the country flag and city with a country fallback", () => {
    expect(countryFlag("JP")).toBe("🇯🇵");
    expect(countryName("JP")).toBe("日本");
    expect(
      locationName({ ip: "192.0.2.10", country: "JP", city: "Tokyo" }),
    ).toBe("日本 · Tokyo");
    expect(locationName({ ip: "192.0.2.10", country: "JP", city: null })).toBe(
      "日本",
    );
    expect(locationName(null)).toBe("");
    expect(countryFlag("XX")).toBe("");
    expect(countryFlag("T1")).toBe("");
  });
});
