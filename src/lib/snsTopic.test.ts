import { describe, expect, it } from "vitest";
import { isAllowedSnsTopic, normalizeSnsTopicArn, parseSnsTopicAllowlist } from "./snsTopic";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:ses-events";

describe("SNS topic allowlist", () => {
  it("repairs common paste mistakes", () => {
    expect(normalizeSnsTopicArn(` "${TOPIC}" `)).toBe(TOPIC);
    expect(normalizeSnsTopicArn(`${TOPIC}:0f5b8c1e-1234-4abc-9def-0123456789ab`)).toBe(TOPIC);
    expect(normalizeSnsTopicArn("arn:aws:sns:us-east-1:123456789012:orders.fifo")).toBe("arn:aws:sns:us-east-1:123456789012:orders.fifo");
    expect(normalizeSnsTopicArn("ses-events")).toBeNull();
  });

  it("accepts several topics", () => {
    const other = "arn:aws:sns:us-west-2:123456789012:ses-events-2";
    expect(parseSnsTopicAllowlist(`${TOPIC}, ${other}\n${TOPIC}`)).toEqual([TOPIC, other]);
  });

  it("matches exactly, and allows any topic only when nothing valid is configured", () => {
    expect(isAllowedSnsTopic(TOPIC, [TOPIC])).toBe(true);
    expect(isAllowedSnsTopic("arn:aws:sns:us-east-1:999999999999:ses-events", [TOPIC])).toBe(false);
    expect(isAllowedSnsTopic(undefined, [TOPIC])).toBe(false);
    expect(isAllowedSnsTopic("anything", [])).toBe(true);
  });
});
