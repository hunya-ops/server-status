import type { ServerNetwork } from "./types";

const countries = new Intl.DisplayNames(["zh-CN"], {
  type: "region",
  fallback: "none",
});

export function countryName(country: string | null): string {
  return country && /^[A-Z]{2}$/.test(country) && country !== "XX"
    ? countries.of(country) || country
    : "";
}

export function countryFlag(country: string | null): string {
  return country && /^[A-Z]{2}$/.test(country) && country !== "XX"
    ? String.fromCodePoint(
        ...[...country].map((letter) => 127397 + letter.charCodeAt(0)),
      )
    : "";
}

export function locationName(network?: ServerNetwork | null): string {
  return [countryName(network?.country ?? null), network?.city]
    .filter(Boolean)
    .join(" · ");
}
