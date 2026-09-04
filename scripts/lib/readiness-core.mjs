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

export function planCampaignBatches({ audience, batches = 3 }) {
  if (!Number.isSafeInteger(audience) || audience < 1) throw new Error("Audience must be a positive integer.");
  if (!Number.isSafeInteger(batches) || batches < 1) throw new Error("Batch count must be a positive integer.");
  if (batches > audience) throw new Error("Batch count cannot exceed audience size.");

  const baseSize = Math.floor(audience / batches);
  const remainder = audience % batches;
  return Array.from({ length: batches }, (_, index) => ({
    batchNumber: index + 1,
    size: baseSize + (index < remainder ? 1 : 0),
    releaseState: index === 0 ? "READY_FOR_APPROVAL" : "QUEUED_FOR_APPROVAL",
  }));
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
