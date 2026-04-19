/**
 * import_list.mjs
 * Run from the project root: node import_list.mjs
 *
 * Creates the list "Amols202604" in Supabase and imports all contacts
 * from AMOLPERS-bounceclean-2026-04-14.csv as list_members.
 *
 * Requirements: node >=18, @supabase/supabase-js installed (already in package.json)
 */

import { createClient } from '@supabase/supabase-js';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_PROJECT_URL  || 'https://yxmnqlxdxrtfnpcvvoww.supabase.co';
const SERVICE_ROLE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_USER_ID       = '00000000-0000-0000-0000-000000000001';
const LIST_NAME           = 'Amols202604';
const LIST_ADDRESS        = 'amols202604@props.sarva.co';
const CSV_PATH            = join(__dirname, 'AMOLPERS-bounceclean-2026-04-14.csv');
const BATCH_SIZE          = 500;
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ── Step 1: Create (or find) the list ────────────────────────────────────────
console.log(`Creating list "${LIST_NAME}"…`);
const { data: listData, error: listError } = await supabase
  .from('lists')
  .upsert(
    { owner_id: ADMIN_USER_ID, name: LIST_NAME, address: LIST_ADDRESS },
    { onConflict: 'address' }
  )
  .select('id')
  .single();

if (listError) {
  console.error('Failed to create list:', listError.message);
  process.exit(1);
}

const listId = listData.id;
console.log(`List ready. ID: ${listId}\n`);

// ── Step 2: Stream CSV and batch-upsert members ───────────────────────────────
let batch       = [];
let totalQueued = 0;
let totalDone   = 0;
let lineNum     = 0;
let errors      = 0;

async function flushBatch() {
  if (!batch.length) return;
  const { error } = await supabase
    .from('list_members')
    .upsert(batch, { onConflict: 'list_id,email' });
  if (error) {
    console.error('\nBatch upsert error:', error.message);
    errors++;
  } else {
    totalDone += batch.length;
  }
  totalQueued += batch.length;
  batch = [];
  process.stdout.write(`\rImported: ${totalDone.toLocaleString()} / queued: ${totalQueued.toLocaleString()}`);
}

console.log(`Streaming ${CSV_PATH}…`);
const rl = createInterface({ input: createReadStream(CSV_PATH) });

for await (const line of rl) {
  lineNum++;
  if (lineNum === 1) continue; // skip header
  const cols  = line.split(',');
  const email = cols[0]?.trim().toLowerCase();
  if (!email || !email.includes('@')) continue;
  batch.push({ list_id: listId, email, status: 'active', source: 'csv_import' });
  if (batch.length >= BATCH_SIZE) await flushBatch();
}
await flushBatch();

console.log(`\n\nDone!`);
console.log(`  Total imported : ${totalDone.toLocaleString()}`);
console.log(`  Batch errors   : ${errors}`);
