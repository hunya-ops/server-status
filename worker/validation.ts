import type { Report } from "../shared/types";

function number(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function text(value: unknown, maximum = 160): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f]/.test(value)
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateReport(value: unknown, now: number): value is Report {
  if (
    !object(value) ||
    value.version !== 1 ||
    !text(value.serverId, 64) ||
    !/^[a-z0-9-]+$/.test(value.serverId)
  )
    return false;
  if (
    !number(value.collectedAt, now - 120, now + 120) ||
    !Number.isInteger(value.collectedAt)
  )
    return false;
  if (
    !text(value.hostname) ||
    !text(value.os) ||
    !text(value.kernel) ||
    !text(value.architecture, 32) ||
    !number(value.uptimeSeconds)
  )
    return false;
  const cpu = value.cpu;
  if (
    !object(cpu) ||
    !number(cpu.usagePercent, 0, 100) ||
    !number(cpu.cores, 1, 4096) ||
    !Number.isInteger(cpu.cores)
  )
    return false;
  if (!number(cpu.load1) || !number(cpu.load5) || !number(cpu.load15))
    return false;
  const memory = value.memory;
  if (
    !object(memory) ||
    !number(memory.totalBytes, 1) ||
    !number(memory.availableBytes) ||
    !number(memory.usedBytes) ||
    !number(memory.usagePercent, 0, 100)
  )
    return false;
  if (
    memory.availableBytes > memory.totalBytes ||
    memory.usedBytes > memory.totalBytes
  )
    return false;
  if (
    Math.abs(memory.usedBytes + memory.availableBytes - memory.totalBytes) >
      4096 ||
    Math.abs(
      memory.usagePercent - (memory.usedBytes / memory.totalBytes) * 100,
    ) > 1
  )
    return false;
  if (
    !Array.isArray(value.disks) ||
    value.disks.length < 1 ||
    value.disks.length > 32
  )
    return false;
  const mounts = new Set<string>();
  for (const disk of value.disks) {
    if (
      !object(disk) ||
      !text(disk.mount, 512) ||
      !disk.mount.startsWith("/") ||
      !text(disk.device, 512) ||
      !text(disk.filesystem, 64)
    )
      return false;
    if (mounts.has(disk.mount)) return false;
    mounts.add(disk.mount);
    if (
      !number(disk.totalBytes, 1) ||
      !number(disk.usedBytes) ||
      !number(disk.availableBytes) ||
      !number(disk.usagePercent, 0, 100)
    )
      return false;
    if (disk.usedBytes + disk.availableBytes > disk.totalBytes + 4096)
      return false;
    const usable = disk.usedBytes + disk.availableBytes;
    if (
      usable > 0 &&
      Math.abs(disk.usagePercent - (disk.usedBytes / usable) * 100) > 1
    )
      return false;
  }
  return true;
}
