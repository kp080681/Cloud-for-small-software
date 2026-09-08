import pg from "pg";

const { Client } = pg;

export function databaseUrl(env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) {
    throw Object.assign(new Error("DATABASE_URL is required for the customer interface."), {
      code: "DATABASE_URL_REQUIRED",
    });
  }
  return url;
}

export async function connectDatabase(env = process.env) {
  const client = new Client({ connectionString: databaseUrl(env) });
  await client.connect();
  return client;
}
