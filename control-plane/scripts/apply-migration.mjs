import fs from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing required environment variable: DATABASE_URL");
const migration = process.env.CONTROL_PLANE_MIGRATION;
if (!migration) throw new Error("Missing required environment variable: CONTROL_PLANE_MIGRATION");

const sql = await fs.readFile(migration, "utf8");
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query(sql);
  console.log(JSON.stringify({ result: "MIGRATION_APPLIED", migration }, null, 2));
} finally {
  await db.end();
}
