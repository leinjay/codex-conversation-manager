import type { UsageBucket } from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalBucketWindow(value: unknown): UsageBucket["primary"] {
  const raw = asRecord(value);
  if (!Object.keys(raw).length) return undefined;
  return {
    usedPercent: numberValue(raw.usedPercent),
    windowDurationMins: numberValue(raw.windowDurationMins),
    resetsAt: timestamp(raw.resetsAt)
  };
}

export function normalizeQuotaBuckets(raw: Record<string, unknown>): UsageBucket[] {
  const byId = asRecord(raw.rateLimitsByLimitId);
  const source = Object.keys(byId).length ? byId : raw.rateLimits ? { [stringValue(asRecord(raw.rateLimits).limitId) ?? "codex"]: raw.rateLimits } : {};
  return Object.entries(source).map(([key, item]) => {
    const bucket = asRecord(item);
    return {
      key,
      label: stringValue(bucket.limitName) ?? stringValue(bucket.limitId) ?? key,
      primary: optionalBucketWindow(bucket.primary),
      secondary: optionalBucketWindow(bucket.secondary)
    };
  });
}
