import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One in-memory app_settings read, so the test can count how often the webhook
// would hit the database per notification.
const state = { value: null as unknown, error: null as unknown, reads: 0 };

vi.mock("@/lib/supabaseAdmin", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            state.reads += 1;
            if (state.error) return { data: null, error: state.error };
            return { data: { value: state.value }, error: null };
          },
        }),
      }),
    }),
  }),
}));

const { __resetSnsTopicCacheForTests, expectedSnsTopicArn, isExpectedSnsTopic } = await import("./snsTopic");

const ARN = "arn:aws:sns:us-east-1:1234:propsmailer1";

beforeEach(() => {
  state.value = { topicArn: ARN };
  state.error = null;
  state.reads = 0;
  delete process.env.AWS_SES_SNS_TOPIC_ARN;
  __resetSnsTopicCacheForTests();
});

afterEach(() => {
  delete process.env.AWS_SES_SNS_TOPIC_ARN;
  vi.restoreAllMocks();
});

describe("expectedSnsTopicArn", () => {
  it("uses the ARN stored from live SES state", async () => {
    expect(await expectedSnsTopicArn()).toBe(ARN);
  });

  it("lets the environment variable override, without reading the database", async () => {
    process.env.AWS_SES_SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:1234:override";
    expect(await expectedSnsTopicArn()).toBe("arn:aws:sns:us-east-1:1234:override");
    expect(state.reads).toBe(0);
  });

  it("caches, so a busy send does not add a read per notification", async () => {
    const start = Date.parse("2026-10-20T12:00:00Z");
    await expectedSnsTopicArn(start);
    await expectedSnsTopicArn(start + 60_000);
    await expectedSnsTopicArn(start + 4 * 60_000);
    expect(state.reads).toBe(1);

    // ...and refreshes once the window rolls over, so a corrected ARN lands.
    state.value = { topicArn: "arn:aws:sns:us-east-1:1234:corrected" };
    expect(await expectedSnsTopicArn(start + 6 * 60_000)).toBe("arn:aws:sns:us-east-1:1234:corrected");
    expect(state.reads).toBe(2);
  });

  it("retries sooner after a failed lookup than after a good one", async () => {
    state.error = { message: "timeout" };
    const start = Date.parse("2026-10-20T12:00:00Z");
    expect(await expectedSnsTopicArn(start)).toBeNull();
    await expectedSnsTopicArn(start + 10_000);
    expect(state.reads).toBe(1);
    await expectedSnsTopicArn(start + 31_000);
    expect(state.reads).toBe(2);
  });
});

describe("isExpectedSnsTopic", () => {
  it("accepts the configured topic and rejects any other", async () => {
    expect(await isExpectedSnsTopic(ARN)).toBe(true);
    expect(await isExpectedSnsTopic("arn:aws:sns:us-east-1:1234:somethingelse")).toBe(false);
  });

  it("accepts anything when no topic is configured, rather than dropping every event", async () => {
    // A database blip must not silently blind the circuit breaker, which is
    // the failure this whole path exists to prevent.
    state.value = null;
    expect(await isExpectedSnsTopic("arn:aws:sns:us-east-1:1234:anything")).toBe(true);
  });
});
