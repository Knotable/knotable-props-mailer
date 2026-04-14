'use client';

import { Component, ReactNode } from "react";
import { reportClientError } from "@/lib/client/logger";

type State = {
  hasError: boolean;
  message?: string;
  correlationId?: string;
};

export class DashboardErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  async componentDidCatch(error: Error) {
    const correlationId = crypto.randomUUID();
    await reportClientError({ message: "Dashboard error", error, correlationId });
    this.setState({ hasError: true, message: error.message, correlationId });
  }

  handleCopy = () => {
    if (!this.state.correlationId) return;
    const payload = `Knotable Props Mail Console Error\nCorrelation ID: ${this.state.correlationId}\nMessage: ${this.state.message}`;
    navigator.clipboard.writeText(payload).catch(() => undefined);
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-900">
        <p className="font-semibold">Something went wrong.</p>
        <p className="mt-2 text-rose-800">Support has been notified automatically.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <button onClick={this.handleCopy} className="rounded-md border border-rose-300 bg-white px-3 py-1">
            Copy diagnostics
          </button>
          {this.state.correlationId && <span>Correlation: {this.state.correlationId}</span>}
        </div>
      </div>
    );
  }
}
