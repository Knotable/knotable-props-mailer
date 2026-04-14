import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const schemaPath = resolve(process.cwd(), "../supabase/schema.sql");
const hashPath = resolve(process.cwd(), "../supabase/.schema-hash");

const schema = readFileSync(schemaPath, "utf8");
const expectedHash = readFileSync(hashPath, "utf8").trim();
const actualHash = createHash("sha256").update(schema).digest("hex");

if (expectedHash !== actualHash) {
  console.error("Supabase schema drift detected.");
  console.error(`Expected ${expectedHash} but found ${actualHash}.`);
  console.error("Run `npm run schema:hash` to update the checksum.");
  process.exit(1);
}

console.log("Supabase schema hash verified.");
