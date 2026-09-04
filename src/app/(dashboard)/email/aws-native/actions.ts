"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdminAuthContext } from "@/lib/authAccess";
import { getNativeCampaignStatus } from "@/lib/awsNativeCampaign";

const dispatchSchema = z.object({
  campaignId: z.string().uuid(),
  manifestKey: z.string().min(1).max(1_024).refine((value) => !value.startsWith("/") && !value.includes(".."), "Invalid manifest key"),
  batchNumber: z.coerce.number().int().min(1).max(3),
  confirmation: z.string().max(256).optional(),
});

async function dispatchWorker(input: z.infer<typeof dispatchSchema>, mode: "dry-run" | "send") {
  if (process.env.AWS_NATIVE_CONTROL_ENABLED !== "true") throw new Error("AWS-native control is not production-enabled.");
  const auth = await requireAdminAuthContext();
  if (!auth.canSend) throw new Error("Send permission required.");
  const token = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  if (!token) throw new Error("Missing GITHUB_ACTIONS_DISPATCH_TOKEN.");
  const repository = process.env.GITHUB_REPOSITORY ?? "Knotable/knotable-props-mailer";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GITHUB_REPOSITORY.");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/ses-native-worker.yml/dispatches`, {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: process.env.GITHUB_ACTIONS_REF ?? "master",
      inputs: {
        campaign_id: input.campaignId,
        manifest_key: input.manifestKey,
        batch_number: String(input.batchNumber),
        mode,
        confirmation: mode === "send" ? input.confirmation ?? "" : "",
        max_recipients_per_second: process.env.SES_BULK_MAX_RECIPIENTS_PER_SECOND ?? "13",
      },
    }),
  });
  if (response.status !== 204) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`GitHub worker dispatch failed (${response.status}): ${detail || "no response body"}`);
  }
}

async function verifyFrozenControl(input: z.infer<typeof dispatchSchema>) {
  const status = await getNativeCampaignStatus(input.campaignId);
  if (!status) throw new Error("Frozen AWS campaign was not found.");
  if (status.manifestKey !== input.manifestKey) throw new Error("Manifest key does not match AWS campaign control state.");
  const batch = status.batches.find((candidate) => candidate.batchNumber === input.batchNumber);
  if (!batch) throw new Error(`Batch ${input.batchNumber} was not found.`);
  return { status, batch };
}

export async function dispatchNativeDryRunAction(formData: FormData) {
  const input = dispatchSchema.parse(Object.fromEntries(formData));
  await verifyFrozenControl(input);
  await dispatchWorker(input, "dry-run");
  redirect(`/email/aws-native?campaignId=${encodeURIComponent(input.campaignId)}&notice=${encodeURIComponent(`Batch ${input.batchNumber} dry-run queued in GitHub Actions.`)}`);
}

export async function dispatchNativeSendAction(formData: FormData) {
  const input = dispatchSchema.parse(Object.fromEntries(formData));
  const { status, batch } = await verifyFrozenControl(input);
  if (!["READY_FOR_APPROVAL", "APPROVED"].includes(batch.releaseState)) {
    throw new Error(`Batch ${input.batchNumber} is ${batch.releaseState}, not ready for approval.`);
  }
  const requiredConfirmation = `send:${input.campaignId}:${status.approvalSha256.slice(0, 12)}:batch:${input.batchNumber}`;
  if (input.confirmation !== requiredConfirmation) throw new Error(`Confirmation must exactly equal ${requiredConfirmation}`);
  await dispatchWorker(input, "send");
  redirect(`/email/aws-native?campaignId=${encodeURIComponent(input.campaignId)}&notice=${encodeURIComponent(`Batch ${input.batchNumber} send worker queued. No other batch was released.`)}`);
}
