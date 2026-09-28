#!/usr/bin/env node
// Local demo backend: an in-memory stand-in for Supabase REST + SES v2 seeded
// with sample campaigns, so the app and the autopilot worker can be exercised
// without production credentials. Nothing here talks to real services.
//
//   node scripts/dev-fake-stack.mjs            # serves http://127.0.0.1:54329
//   then run `next dev` and the worker with the env it prints.
import crypto from "node:crypto";
import { createFakeBackend } from "./lib/test-support/fake-backend.mjs";

const port = Number(process.env.FAKE_STACK_PORT ?? 54329);
const backend = createFakeBackend({ lenient: true });
const HOLD = "2999-12-31T23:59:59.000Z";
const bypassPassword = process.env.FAKE_BYPASS_PASSWORD ?? "local-demo-bypass";

backend.tables.profiles = [{ id: "00000000-0000-0000-0000-000000000001", email: "a@sarva.co", role: "admin", can_send: true }];
const list = { id: crypto.randomUUID(), owner_id: "00000000-0000-0000-0000-000000000001", name: "Demo newsletter", address: "demo@props.local" };
backend.tables.lists = [list];

function campaign(subject, status, recipients) {
  const email = {
    id: crypto.randomUUID(),
    author_id: "00000000-0000-0000-0000-000000000001",
    from_address: "Demo Sender <sender@example.test>",
    reply_to: "reply@example.test",
    subject,
    html: "<p>Hello {{firstName | friend}}</p>",
    text: "Hello {{firstName | friend}}",
    status,
    tags: [],
    campaigns: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  backend.tables.emails.push(email);
  for (let index = 0; index < recipients; index += 1) {
    backend.tables.mail_queue.push({
      id: crypto.randomUUID(),
      email_id: email.id,
      list_id: list.id,
      payload: { to: `person${index}@example.test`, toName: `Person ${index}` },
      status: "pending",
      attempts: 0,
      max_attempts: 5,
      available_at: HOLD,
      created_at: new Date(Date.now() + index).toISOString(),
      updated_at: new Date(Date.now() + index).toISOString(),
    });
  }
  return email;
}

campaign("October investor update", "queued", 250);
campaign("Legacy stuck send", "sending", 40);
campaign("Next month draft", "draft", 0);

const url = await backend.start(port);
const hmacKey = crypto.randomBytes(32).toString("hex");
const passwordSha = crypto.createHash("sha256").update(bypassPassword).digest("hex");
console.log(`Fake Supabase + SES listening at ${url}\n`);
console.log("App env:");
console.log(`  NEXT_PUBLIC_SUPABASE_URL=${url} NEXT_PUBLIC_SUPABASE_ANON_KEY=anon SUPABASE_SERVICE_ROLE_KEY=service BYPASS_PASSWORD_SHA256=${passwordSha} BYPASS_COOKIE_HMAC_KEY=${hmacKey}`);
console.log(`  Bypass password: ${bypassPassword}\n`);
console.log("Worker env:");
console.log(`  SUPABASE_URL=${url} SUPABASE_SERVICE_ROLE_KEY=service APP_BASE_URL=http://localhost:3000 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=x AWS_ENDPOINT_URL=${url} SES_QUOTA_RESERVE=0`);
