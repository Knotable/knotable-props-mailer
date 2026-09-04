export function requiredSesCapacity({
  audience,
  quotaBuffer = 1.2,
  maxDurationMinutes = 60,
  workerUtilization = 0.9,
}) {
  if (!Number.isFinite(audience) || audience < 1) throw new Error("Audience must be positive.");
  if (!Number.isFinite(quotaBuffer) || quotaBuffer < 1) throw new Error("Quota buffer must be at least 1.");
  if (!Number.isFinite(maxDurationMinutes) || maxDurationMinutes < 1) throw new Error("Maximum duration must be positive.");
  if (!Number.isFinite(workerUtilization) || workerUtilization <= 0 || workerUtilization > 1) {
    throw new Error("Worker utilization must be greater than 0 and at most 1.");
  }

  return {
    requiredDailyQuota: Math.ceil(audience * quotaBuffer),
    requiredSesRate: Math.ceil(audience / (maxDurationMinutes * 60 * workerUtilization)),
  };
}

export function evaluateSesCapacity({ audience, max24Hour, sentLast24Hours, maxRate, ...policy }) {
  const required = requiredSesCapacity({ audience, ...policy });
  const headroom = Math.max(0, Math.floor(max24Hour - sentLast24Hours));
  return {
    ...required,
    headroom,
    quotaReady: max24Hour >= required.requiredDailyQuota && headroom >= audience,
    rateReady: maxRate >= required.requiredSesRate,
    estimatedMinutes: maxRate > 0 ? Math.ceil(audience / (maxRate * (policy.workerUtilization ?? 0.9)) / 60) : null,
  };
}
