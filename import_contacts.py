#!/usr/bin/env python3
"""
Bulk-imports AMOLPERS-bounceclean-2026-04-14.csv into Supabase list_members.
Run from project root: python3 import_contacts.py
"""
import csv, json, urllib.request, urllib.error, os, sys

SUPABASE_URL   = 'https://yxmnqlxdxrtfnpcvvoww.supabase.co'
ANON_KEY       = 'sb_publishable_7t0JdS34n-dkifql3_u4UQ_YA6cg2xK'
LIST_ID        = 'dbd52a08-9a38-4573-bf06-09e401015ae9'
CSV_PATH       = os.path.join(os.path.dirname(__file__), 'AMOLPERS-bounceclean-2026-04-14.csv')
BATCH_SIZE     = 500

def insert_batch(batch):
    data = json.dumps(batch).encode()
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/list_members',
        data=data,
        headers={
            'apikey': ANON_KEY,
            'Authorization': f'Bearer {ANON_KEY}',
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
