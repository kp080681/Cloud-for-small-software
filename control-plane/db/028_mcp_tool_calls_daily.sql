BEGIN;

-- How much the MCP server is actually used: tool calls per workspace, per
-- tool, per day. Counts only; no arguments or results are stored.
CREATE TABLE mcp_tool_calls_daily (
  day date NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool text NOT NULL,
  succeeded integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, workspace_id, tool)
);

COMMIT;
