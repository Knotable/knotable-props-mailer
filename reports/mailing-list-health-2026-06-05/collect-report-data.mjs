import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const OUT_PATH = resolve("reports/mailing-list-health-2026-06-05/report-data.json");
const PAGE_SIZE = 1000;
const EMAIL_RE = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/i;
const EMAIL_FIND_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const importFiles = [
  {
    name: "Family Offices 2026 06 05",
    path: "/Users/MrAnonymous/Downloads/Family Offices 2026 06 05.csv",
    kind: "affinity_people",
  },
  {
    name: "High Net Worth Amols Friends 2026 06 05",
    path: "/Users/MrAnonymous/Downloads/High Net Worth Amols Friends 2026 06 05.csv",
    kind: "affinity_people",
  },
  {
    name: "Limited Partner Pipeline 2026 06 05",
    listName: "LP Pipeline 2026 06 05",
    path: "/Users/MrAnonymous/Downloads/LP Pipeline 2026 06 05.csv",
    kind: "affinity_pipeline",
  },
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

function rowObjects(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((cols, index) => {
    const row = { __row_number: index + 2 };
    headers.forEach((header, i) => {
      row[header] = (cols[i] || "").trim();
    });
    return row;
  });
}

function normalizeEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/[)>.,;]+$/g, "");
  return EMAIL_RE.test(email) ? email : null;
}

function emailsFromImportRow(row, kind) {
  if (kind === "affinity_pipeline") {
    return String(row.People || "")
      .split(";")
      .flatMap((person) => person.match(EMAIL_FIND_RE) || [])
      .map(normalizeEmail)
      .filter(Boolean);
  }

  const primary = normalizeEmail(row["Primary Email"]);
  if (primary) return [primary];
  return String(row["Email Addresses"] || "")
    .match(EMAIL_FIND_RE)
    ?.map(normalizeEmail)
    .filter(Boolean) || [];
}

function summarizeImportFile(file) {
  const rows = rowObjects(file.path);
  const seen = new Set();
  let extracted = 0;
  let duplicate = 0;
  let rowsWithRecipient = 0;

  for (const row of rows) {
    const emails = emailsFromImportRow(row, file.kind);
    if (emails.length) rowsWithRecipient += 1;
    extracted += emails.length;
    for (const email of emails) {
      if (seen.has(email)) duplicate += 1;
      seen.add(email);
    }
  }

  return {
    list_name: file.listName || file.name,
    display_name: file.name,
    source_file: basename(file.path),
    csv_rows: rows.length,
    rows_with_recipient: rowsWithRecipient,
    extracted_email_occurrences: extracted,
    unique_emails: seen.size,
    duplicate_email_occurrences: duplicate,
    rows_without_recipient: rows.length - rowsWithRecipient,
  };
}

async function fetchAll(label, buildQuery) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${label}: ${error.message || JSON.stringify(error)}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return out;
  }
}

async function safeCount(label, buildQuery) {
  const { count, error } = await buildQuery();
  return {
    label,
    count: error ? null : count,
    error: error ? error.message || JSON.stringify(error) : null,
  };
}

function topEntries(map, limit = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

const report = {
  generated_at: new Date().toISOString(),
  source_window: {
    imports: "CSV files dated 2026-06-05",
    database_snapshot: "Live Supabase reads during report generation",
  },
};

report.imports = importFiles.map(summarizeImportFile);

const { data: lists, error: listsError } = await supabase
  .from("lists")
  .select("id,name,address,created_at")
  .order("created_at", { ascending: true });
if (listsError) throw listsError;

const listById = new Map(lists.map((list) => [list.id, list]));
const listCounts = new Map(
  lists.map((list) => [
    list.id,
    {
      total: 0,
      active: 0,
      unsubscribed: 0,
      other_status: 0,
      top_domains: new Map(),
      top_countries: new Map(),
    },
  ]),
);

const members = await fetchAll("list_members", () =>
  supabase.from("list_members").select("list_id,email,status,metadata").order("id", { ascending: true }),
);

for (const member of members) {
  const stats = listCounts.get(member.list_id);
  if (!stats) continue;
  stats.total += 1;
  if (member.status === "active") stats.active += 1;
  else if (member.status === "unsubscribed") stats.unsubscribed += 1;
  else stats.other_status += 1;

  const domain = String(member.email || "").split("@")[1];
  if (domain) stats.top_domains.set(domain, (stats.top_domains.get(domain) || 0) + 1);

  const country = member.metadata?.country || member.metadata?.["Location (Country)"];
  if (typeof country === "string" && country.trim()) {
    stats.top_countries.set(country.trim(), (stats.top_countries.get(country.trim()) || 0) + 1);
  }
}

report.lists = lists.map((list) => {
  const stats = listCounts.get(list.id);
  return {
    ...list,
    total_members: stats.total,
    active_members: stats.active,
    unsubscribed_members: stats.unsubscribed,
    net_members: stats.total - stats.unsubscribed,
    other_status_members: stats.other_status,
    unsubscribe_rate: stats.total ? stats.unsubscribed / stats.total : 0,
    top_domains: topEntries(stats.top_domains, 8),
    top_countries: topEntries(stats.top_countries, 8),
  };
});

const providerEvents = await fetchAll("provider_events", () =>
  supabase.from("provider_events").select("event_type,email_id,recipient,received_at").order("id", { ascending: true }),
);
const eventCounts = new Map();
const eventRecipients = new Map();
for (const event of providerEvents) {
  eventCounts.set(event.event_type, (eventCounts.get(event.event_type) || 0) + 1);
  if (!eventRecipients.has(event.event_type)) eventRecipients.set(event.event_type, new Set());
  if (event.recipient) eventRecipients.get(event.event_type).add(event.recipient.toLowerCase());
}
report.provider_events = {
  total_events: providerEvents.length,
  by_type: [...eventCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([event_type, count]) => ({
      event_type,
      count,
      unique_recipients: eventRecipients.get(event_type)?.size || 0,
    })),
  note: "Most stored provider events do not have an email identifier, so event counts are useful as overall engagement signals but cannot reliably be attributed to individual campaigns.",
};

report.queue_status = {};
for (const status of ["pending", "processing", "succeeded", "failed", "dead", "canceled"]) {
  report.queue_status[status] = await safeCount(status, () =>
    supabase.from("mail_queue").select("id", { count: "exact", head: true }).eq("status", status),
  );
}

const importantCampaigns = [
  {
    label: "LifeX is getting loud: exits, London, and useful little machines",
    email_id: "532a06ae-c296-4f93-8483-e250d803f08d",
    list_id: "dbd52a08-9a38-4573-bf06-09e401015ae9",
    list_name: "Amols202604",
    queued_at: "2026-05-31",
  },
  {
    label: "NY: birthday + LifeX Fund 2",
    email_id: "696a333a-4909-41e8-ad3e-81c2e11b39db",
    list_id: "dbd52a08-9a38-4573-bf06-09e401015ae9",
    list_name: "Amols202604",
    queued_at: "2026-05-07",
    fallback_counts: { succeeded: 63553, canceled: 122592, dead: 1, pending: 0, processing: 0, failed: 0 },
    fallback_note: "The exact live succeeded count timed out during report generation; this count is from the checked-in operator status and matched the prior campaign cancellation audit.",
  },
  {
    label: "London and NY: join me (birthday)",
    email_id: "83cd5759-c4fe-46f2-a450-9badbff4b8c3",
    list_id: "dbd52a08-9a38-4573-bf06-09e401015ae9",
    list_name: "Amols202604",
    queued_at: "2026-04-21",
  },
  {
    label: "NY: you survived + LifeX Fund 2",
    email_id: "aacdd257-4604-4f0c-b13d-54add0aff534",
    list_id: "82af752b-6db1-4761-bc59-70f8400f1b00",
    list_name: "Amols 5k",
    queued_at: "2026-05-11",
  },
  {
    label: "come to my birthday next week // may 9",
    email_id: "97827d0d-df11-4267-ae8e-289bffc5b86f",
    list_id: "82af752b-6db1-4761-bc59-70f8400f1b00",
    list_name: "Amols 5k",
    queued_at: "2026-05-02",
  },
  {
    label: "Paris this week: founders meetup on Thursday",
    email_id: "0949ffd6-044c-42e9-97ba-585a72281c6a",
    list_id: "f277cd3e-2d1b-4574-85a8-d86ef90ce5a8",
    list_name: "AmolsParis",
    queued_at: "2026-05-31",
  },
  {
    label: "Alive in Tokyo: a funeral, an app store, and two new tools",
    email_id: "f67b717c-eea4-4d24-a55a-8bdb0c68d301",
    list_id: "1a5d810a-bfb5-4e3c-b014-a454942aa7ed",
    list_name: "Amol's Test List",
    queued_at: "2026-05-30",
  },
  {
    label: "NY: birthday + LifeX Fund 2",
    email_id: "e1c5bbd1-5f25-44fc-83db-9a024dc1f165",
    list_id: "1a5d810a-bfb5-4e3c-b014-a454942aa7ed",
    list_name: "Amol's Test List",
    queued_at: "2026-05-06",
  },
  {
    label: "NY: birthday + LifeX Fund 2",
    email_id: "1065a3c3-efb8-4b91-8593-de918919ac0a",
    list_id: "1a5d810a-bfb5-4e3c-b014-a454942aa7ed",
    list_name: "Amol's Test List",
    queued_at: "2026-04-30",
  },
];

for (const campaign of importantCampaigns) {
  campaign.counts = {};
  for (const status of ["pending", "processing", "succeeded", "failed", "dead", "canceled"]) {
    const result = await safeCount(status, () =>
      supabase
        .from("mail_queue")
        .select("id", { count: "exact", head: true })
        .eq("list_id", campaign.list_id)
        .eq("email_id", campaign.email_id)
        .eq("status", status),
    );
    campaign.counts[status] = result.count ?? campaign.fallback_counts?.[status] ?? null;
    if (result.error) campaign.counts_error = { ...(campaign.counts_error || {}), [status]: result.error };
  }
}
report.campaigns = importantCampaigns;

const { data: emailRows, error: emailsError } = await supabase
  .from("emails")
  .select("id,subject,status,created_at,sent_at,is_test")
  .order("created_at", { ascending: true });
if (emailsError) throw emailsError;
report.emails = {
  total: emailRows.length,
  by_status: topEntries(
    emailRows.reduce((map, email) => map.set(email.status, (map.get(email.status) || 0) + 1), new Map()),
    20,
  ),
  by_month: topEntries(
    emailRows.reduce((map, email) => {
      const month = String(email.created_at || "").slice(0, 7) || "unknown";
      return map.set(month, (map.get(month) || 0) + 1);
    }, new Map()),
    20,
  ).sort((a, b) => a.name.localeCompare(b.name)),
};

report.recent_mailings_by_list = {
  "Amol's Test List": report.campaigns
    .filter((campaign) => campaign.list_name === "Amol's Test List")
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
    .slice(0, 3),
  Amols202604: report.campaigns
    .filter((campaign) => campaign.list_name === "Amols202604")
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
    .slice(0, 3),
  "Amols 5k": report.campaigns
    .filter((campaign) => campaign.list_name === "Amols 5k")
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
    .slice(0, 3),
  humanswhoreply: [],
  AmolsParis: report.campaigns
    .filter((campaign) => campaign.list_name === "AmolsParis")
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
    .slice(0, 3),
  "Family Offices 2026 06 05": [],
  "High Net Worth Amols Friends 2026 06 05": [],
  "LP Pipeline 2026 06 05": [],
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(OUT_PATH);
