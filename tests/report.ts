import type { Report } from "../shared/types";
export function report(
  serverId = "example-server",
  collectedAt = Math.floor(Date.now() / 1000),
): Report {
  return {
    version: 1,
    serverId,
    collectedAt,
    hostname: "test-host",
    os: "Debian GNU/Linux 13",
    kernel: "6.12-test",
    architecture: "x86_64",
    cpu: { usagePercent: 23, cores: 2, load1: 0.3, load5: 0.2, load15: 0.1 },
    memory: {
      totalBytes: 1024 * 1024 * 1024,
      availableBytes: 768 * 1024 * 1024,
      usedBytes: 256 * 1024 * 1024,
      usagePercent: 25,
    },
    disks: [
      {
        mount: "/",
        device: "/dev/sda1",
        filesystem: "ext4",
        totalBytes: 1000,
        usedBytes: 300,
        availableBytes: 700,
        usagePercent: 30,
      },
    ],
    uptimeSeconds: 123456,
  };
}
