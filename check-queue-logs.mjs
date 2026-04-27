// check-queue-logs.mjs — run with: node check-queue-logs.mjs
// Queries Supabase for queue activity from the last 5 hours

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, 'env.keys');

// Parse env.keys
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
}

const supabase = createClient(env.SUPABASE_PROJECT_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const since = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

console.log(`\n=== Checking queue activity since ${since} ===\n`);

// 1. Recent emails
const { data: emails, error: emailErr } = await supabase
  .from('emails')
  .select('id, subject, status, created_at, updated_at')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(20);

console.log('--- EMAILS ---');
if (emailErr) console.error('Error:', emailErr.message);
else if (!emails?.length) console.log('No emails found in last 5 hours.');
else emails.forEach(e => console.log(`[${e.status}] "${e.subject}" | created: ${e.created_at} | id: ${e.id}`));

// 2. Mail queue entries
const { data: queue, error: queueErr } = await supabase
  .from('mail_queue')
  .select('id, email_id, status, attempts, max_attempts, last_error, created_at, updated_at, locked_at, available_at')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(50);

console.log('\n--- MAIL QUEUE ---');
if (queueErr) console.error('Error:', queueErr.message);
else if (!queue?.length) console.log('No queue entries in last 5 hours.');
else {
  const counts = {};
  for (const q of queue) {
    counts[q.status] = (counts[q.status] || 0) + 1;
  }
  console.log('Status counts:', counts);

  const failed = queue.filter(q => q.status === 'dead' || q.last_error);
  if (failed.length) {
    console.log('\nFailed/dead entries:');
    for (const q of failed) {
      console.log(`  [${q.status}] id=${q.id} attempts=${q.attempts}/${q.max_attempts} error="${q.last_error}"`);
    }
  }
}

// 3. Queue metrics (last few runs)
const { data: metrics, error: metricsErr } = await supabase
  .from('queue_metrics')
  .select('*')
  .order('last_run_at', { ascending: false })
  .limit(10);

console.log('\n--- QUEUE METRICS (last 10 runs) ---');
if (metricsErr) console.error('Error:', metricsErr.message);
else if (!metrics?.length) console.log('No metrics found.');
else metrics.forEach(m => console.log(`  [${m.last_run_at}] depth=${m.queue_depth} processed=${m.processed_count} failed=${m.failed_count}`));

// 4. Error logs
const { data: errors, error: errErr } = await supabase
  .from('error_logs')
  .select('id, source, message, stack, payload, created_at')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(20);

console.log('\n--- ERROR LOGS ---');
if (errErr) console.error('Error:', errErr.message);
else if (!errors?.length) console.log('No error logs in last 5 hours.');
else errors.forEach(e => console.log(`  [${e.created_at}] [${e.source}] ${e.message}`));

// 5. Today's quota status
const today = new Date().toISOString().slice(0, 10);
const { count: sentToday } = await supabase
  .from('mail_queue')
  .select('id', { count: 'exact', head: true })
  .eq('send_date', today)
  .eq('status', 'succeeded');

const { count: pendingCount } = await supabase
  .from('mail_queue')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'pending');

const { count: deadCount } = await supabase
  .from('mail_queue')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'dead');

console.log(`\n--- TODAY'S QUOTA (${today}) ---`);
console.log(`  Sent today: ${sentToday ?? '?'} / 45,000`);
console.log(`  Pending in queue: ${pendingCount ?? '?'}`);
console.log(`  Dead (failed): ${deadCount ?? '?'}`);
