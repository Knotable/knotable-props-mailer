'use client';

import log from "loglevel";

const LEVEL: log.LogLevelDesc = process.env.NODE_ENV === "production" ? "warn" : "debug";
log.setDefaultLevel(LEVEL);

export type ClientLogPayload = {
  message: string;
  level?: log.LogLevelDesc;
  context?: Record<string, unknown>;
  error?: unknown;
  correlationId?: string;
};

export const clientLog = ({ message, level = "info", context, error }: ClientLogPayload) => {
  if (error instanceof Error) {
    log[level](`${message}: ${error.message}`, { stack: error.stack, ...context });
  } else {
    log[level](message, context);
  }
};

export const reportClientError = async (payload: ClientLogPayload) => {
  clientLog({ ...payload, level: "error" });
  try {
    await fetch("/api/log/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: payload.message,
        context: payload.context,
        stack: payload.error instanceof Error ? payload.error.stack : undefined,
        correlationId: payload.correlationId,
      }),
    });
  } catch (err) {
    log.warn("Unable to report client error", err);
  }
};
