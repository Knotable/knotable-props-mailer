import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { GetAccountCommand, SESv2Client } from "@aws-sdk/client-sesv2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function batchKey(batchNumber: number) {
  return `!BATCH#${String(batchNumber).padStart(3, "0")}`;
}

function numeric(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export type NativeBatchStatus = {
  batchNumber: number;
  releaseState: string;
  startOrdinal: number;
  endOrdinal: number;
  recipientCount: number;
  accepted: number;
  claimed: number;
  retry: number;
  dead: number;
  canceled: number;
  updatedAt: string | null;
  completedAt: string | null;
  operatorNoticeState: string | null;
  operatorNoticeSentAt: string | null;
};

export type NativeCampaignStatus = {
  campaignId: string;
  subject: string;
  manifestKey: string;
  approvalSha256: string;
  recipientCount: number;
  updatedAt: string | null;
  batches: NativeBatchStatus[];
  quota: {
    max24Hour: number;
    sentLast24Hours: number;
    remaining: number;
    maxRate: number;
  };
};

export async function getNativeCampaignStatus(campaignId: string): Promise<NativeCampaignStatus | null> {
  if (!UUID.test(campaignId)) throw new Error("Campaign id must be a UUID.");
  const region = required("AWS_REGION");
  const tableName = required("SES_CAMPAIGN_STATE_TABLE");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const ses = new SESv2Client({ region });
  const metaResponse = await db.send(new GetCommand({
    TableName: tableName,
    Key: { campaign_id: campaignId, recipient_hash: "!META" },
    ConsistentRead: true,
  }));
  const meta = metaResponse.Item;
  if (!meta?.approval_sha256 || !meta?.manifest_key) return null;
  const batchCount = numeric(meta.batch_count);
  if (!Number.isSafeInteger(batchCount) || batchCount < 1 || batchCount > 3) {
    throw new Error(`Campaign has invalid batch_count ${meta.batch_count ?? "missing"}.`);
  }

  const [account, ...batchResponses] = await Promise.all([
    ses.send(new GetAccountCommand({})),
    ...Array.from({ length: batchCount }, (_, index) => db.send(new GetCommand({
      TableName: tableName,
      Key: { campaign_id: campaignId, recipient_hash: batchKey(index + 1) },
      ConsistentRead: true,
    }))),
  ]);
  const batches = batchResponses.map((response, index) => {
    const item = response.Item;
    if (!item) throw new Error(`Campaign batch ${index + 1} is missing.`);
    return {
      batchNumber: numeric(item.batch_number),
      releaseState: String(item.release_state ?? "UNKNOWN"),
      startOrdinal: numeric(item.start_ordinal),
      endOrdinal: numeric(item.end_ordinal),
      recipientCount: numeric(item.recipient_count),
      accepted: numeric(item.accepted),
      claimed: numeric(item.claimed),
      retry: numeric(item.retry),
      dead: numeric(item.dead),
      canceled: numeric(item.canceled),
      updatedAt: typeof item.updated_at === "string" ? item.updated_at : null,
      completedAt: typeof item.completed_at === "string" ? item.completed_at : null,
      operatorNoticeState: typeof item.operator_notice_state === "string" ? item.operator_notice_state : null,
      operatorNoticeSentAt: typeof item.operator_notice_sent_at === "string" ? item.operator_notice_sent_at : null,
    };
  });
  const max24Hour = numeric(account.SendQuota?.Max24HourSend);
  const sentLast24Hours = numeric(account.SendQuota?.SentLast24Hours);
  return {
    campaignId,
    subject: String(meta.campaign_subject ?? "Untitled campaign"),
    manifestKey: String(meta.manifest_key),
    approvalSha256: String(meta.approval_sha256),
    recipientCount: numeric(meta.recipient_count),
    updatedAt: typeof meta.updated_at === "string" ? meta.updated_at : null,
    batches,
    quota: {
      max24Hour,
      sentLast24Hours,
      remaining: Math.max(0, Math.floor(max24Hour - sentLast24Hours)),
      maxRate: numeric(account.SendQuota?.MaxSendRate),
    },
  };
}
