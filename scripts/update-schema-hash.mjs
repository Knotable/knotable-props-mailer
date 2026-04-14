import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const schemaPath = resolve(process.cwd(), "../supabase/schema.sql");
const hashPath = resolve(process.cwd(), "../supabase/.schema-hash");

const schema = readFileSync(schemaPath, "utf8");
const hash = createHash("sha256").update(schema).digest("hex");
writeFileSync(hashPath, `${hash}\n`);

console.log(`Updated schema hash -> ${hash}`);
