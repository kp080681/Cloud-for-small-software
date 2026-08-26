import postgres from "postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL;
  const marker = process.env.APP_BUILD_MARKER;

  if (!databaseUrl || !marker) {
    return Response.json({ ok: false, error: "configuration_missing" }, { status: 500 });
  }

  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 5 });

  try {
    await sql`
      create table if not exists spike_c_health (
        marker text primary key,
        touched_at timestamptz not null default now()
      )
    `;

    await sql`
      insert into spike_c_health (marker)
      values (${marker})
      on conflict (marker) do update set touched_at = now()
    `;

    const rows = await sql`
      select marker from spike_c_health where marker = ${marker} limit 1
    `;

    return Response.json({
      ok: rows[0]?.marker === marker,
      service: "ssc-spike-c-test-app",
      marker: rows[0]?.marker ?? null,
      database: "read-write-verified",
    });
  } catch {
    return Response.json({ ok: false, error: "database_health_failed" }, { status: 503 });
  } finally {
    await sql.end({ timeout: 2 });
  }
}
