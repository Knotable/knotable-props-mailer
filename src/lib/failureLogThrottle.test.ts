import { describe, expect, it } from "vitest";
import { FailureLogThrottle } from "./failureLogThrottle";

const WINDOW = 5 * 60_000;
const T0 = Date.parse("2026-10-20T07:00:00Z");

describe("FailureLogThrottle", () => {
  it("logs the first occurrence and suppresses the rest of the window", () => {
    const throttle = new FailureLogThrottle(WINDOW);
    expect(throttle.consider("Unexpected SNS topic", T0)).toEqual({ log: true, suppressed: 0 });
    expect(throttle.consider("Unexpected SNS topic", T0 + 1_000).log).toBe(false);
    expect(throttle.consider("Unexpected SNS topic", T0 + 2_000).log).toBe(false);
  });

  it("reports how many were suppressed with the next one it lets through", () => {
    const throttle = new FailureLogThrottle(WINDOW);
    throttle.consider("Unexpected SNS topic", T0);
    for (let i = 0; i < 5_000; i += 1) throttle.consider("Unexpected SNS topic", T0 + 1_000);
    // A 180k send's worth of rejected bounces costs two rows, not 5,001.
    expect(throttle.consider("Unexpected SNS topic", T0 + WINDOW + 1)).toEqual({ log: true, suppressed: 5_000 });
  });

  it("throttles each kind of failure separately", () => {
    const throttle = new FailureLogThrottle(WINDOW);
    expect(throttle.consider("Unexpected SNS topic", T0).log).toBe(true);
    expect(throttle.consider("SNS signature verification failed", T0).log).toBe(true);
    expect(throttle.consider("Unexpected SNS topic", T0 + 1).log).toBe(false);
  });

  it("starts a fresh count after a window with nothing suppressed", () => {
    const throttle = new FailureLogThrottle(WINDOW);
    throttle.consider("x", T0);
    expect(throttle.consider("x", T0 + WINDOW + 1)).toEqual({ log: true, suppressed: 0 });
  });
});
