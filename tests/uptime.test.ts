import { describe, expect, it } from "vitest";
import { DAY_SECONDS, uptimeHistory } from "../shared/uptime";

const day = Date.UTC(2026, 9, 12) / 1000;

describe("public heartbeat uptime", () => {
  it("leaves dates before monitoring unknown and counts only elapsed time", () => {
    const result = uptimeHistory(
      day + 3600,
      [{ started_at: day + 3600, ended_at: day + 5000 }],
      day + 4000,
    );
    expect(result.days).toHaveLength(90);
    expect(result.days.at(-1)).toEqual({
      date: "2026-10-12",
      uptimePercent: 100,
    });
    expect(
      result.days.slice(0, -1).every((value) => value.uptimePercent === null),
    ).toBe(true);
    expect(result.uptimePercent).toBe(100);
    expect(uptimeHistory(null, [], day + 4000).uptimePercent).toBeNull();
    expect(uptimeHistory(day, [], day).uptimePercent).toBeNull();
  });

  it("splits coverage at midnight and weights partial days by duration", () => {
    const result = uptimeHistory(
      day - 3600,
      [{ started_at: day - 3600, ended_at: day + 1800 }],
      day + 3600,
    );
    expect(result.days.at(-2)?.uptimePercent).toBe(100);
    expect(result.days.at(-1)?.uptimePercent).toBe(50);
    expect(result.uptimePercent).toBe(75);
  });

  it("counts gaps and offline days, excluding coverage outside the window", () => {
    const result = uptimeHistory(
      day - 100 * DAY_SECONDS,
      [
        {
          started_at: day - 100 * DAY_SECONDS,
          ended_at: day - 90 * DAY_SECONDS,
        },
        { started_at: day, ended_at: day + 900 },
        { started_at: day + 2700, ended_at: day + 3600 },
      ],
      day + 3600,
    );
    expect(result.days.at(-1)?.uptimePercent).toBe(50);
    expect(
      result.days.slice(0, -1).every((value) => value.uptimePercent === 0),
    ).toBe(true);
    expect(result.uptimePercent).toBeCloseTo(
      (1800 / (89 * DAY_SECONDS + 3600)) * 100,
    );
  });
});
