// Daily MCP tool-call counts (2026-10-29), so the founder can see whether
// people who find Utplava in an AI assistant's directory actually use it.
// Best-effort: counting must never affect the tool call itself.

export async function recordToolCall(db, { workspaceId, toolName, ok }, now = new Date()) {
  if (!db || !workspaceId || !toolName) return;
  const day = now.toISOString().slice(0, 10);
  await db
    .query(
      `INSERT INTO mcp_tool_calls_daily (day, workspace_id, tool, succeeded, failed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (day, workspace_id, tool) DO UPDATE SET
         succeeded = mcp_tool_calls_daily.succeeded + EXCLUDED.succeeded,
         failed = mcp_tool_calls_daily.failed + EXCLUDED.failed`,
      [day, workspaceId, toolName, ok ? 1 : 0, ok ? 0 : 1],
    )
    .catch(() => {});
}
