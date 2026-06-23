#!/usr/bin/env python3
"""
Bulk-imports a bounce-clean CSV into Supabase list_members.
Run from project root: python3 import_contacts.py

Place your export at private/AMOLPERS-bounceclean-2026-04-14.csv (the
private/ directory is gitignored) — never at the repo root, where it would
get tracked by git. list_members has RLS enabled, so this needs the
service-role key, not the anon key; set SUPABASE_PROJECT_URL,
SUPABASE_SERVICE_ROLE_KEY, and LIST_ID as env vars before running.
"""
import csv, json, urllib.request, urllib.error, os, sys

SUPABASE_URL   = os.environ['SUPABASE_PROJECT_URL']
SERVICE_KEY    = os.environ['SUPABASE_SERVICE_ROLE_KEY']
LIST_ID        = os.environ['LIST_ID']
CSV_PATH       = os.path.join(os.path.dirname(__file__), 'private', 'AMOLPERS-bounceclean-2026-04-14.csv')
BATCH_SIZE     = 500

def insert_batch(batch):
    data = json.dumps(batch).encode()
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/list_members',
        data=data,
        headers={
            'apikey': SERVICE_KEY,
            'Authorization': f'Bearer {SERVICE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates',
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        print(f'  HTTP {e.code}: {e.read().decode()[:200]}')
        return e.code

rows, batch, total = [], [], 0
with open(CSV_PATH, newline='') as f:
    for row in csv.DictReader(f):
        email = row['address'].strip()
        if not email:
            continue
        batch.append({'list_id': LIST_ID, 'email': email, 'status': 'active'})
        if len(batch) >= BATCH_SIZE:
            status = insert_batch(batch)
            total += len(batch)
            if total % 10000 == 0:
                print(f'  {total} inserted...')
            batch = []

if batch:
    insert_batch(batch)
    total += len(batch)

print(f'Done! {total} contacts imported into Amols202604.')
