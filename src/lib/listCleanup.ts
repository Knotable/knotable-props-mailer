// Parses an operator's cleanup targets: bare domains ("dwight.edu", "@cis.dk")
// match that exact domain only; full addresses match exactly. The owner
// address is never a target.
export function parseSuppressTargets(raw: string, ownerEmail = "") {
  const domains = new Set<string>();
  const addresses = new Set<string>();
  for (const token of raw.split(/[\s,;]+/)) {
    const value = token.trim().toLowerCase().replace(/^@/, "");
    if (!value) continue;
    if (value.includes("@")) {
      if (/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) addresses.add(value);
    } else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) {
      domains.add(value);
    }
  }
  addresses.delete(ownerEmail.toLowerCase());
  return { domains: [...domains], addresses: [...addresses] };
}
