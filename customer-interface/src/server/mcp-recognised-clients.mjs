// Which MCP clients Utplava recognises on the consent screen (2026-10-29).
//
// A client's name is self-reported at registration, so recognition is based
// only on where the authorization code will be sent (the redirect_uri),
// which an attacker can't use to receive a victim's code:
// - well-known hosted clients' own callback hosts;
// - loopback addresses (a tool running on the person's own computer);
// - the URI schemes of well-known desktop editors.
// Anything else gets a loud warning, and Allow requires an explicit
// "I set this up myself" confirmation, enforced server-side.

const HOSTS = new Map([
  ["claude.ai", "Claude"],
  ["claude.com", "Claude"],
  ["chatgpt.com", "ChatGPT"],
  ["chat.openai.com", "ChatGPT"],
  ["vscode.dev", "VS Code"],
  ["insiders.vscode.dev", "VS Code"],
  ["glama.ai", "Glama"],
]);

const SCHEMES = new Map([
  ["cursor:", "Cursor"],
  ["vscode:", "VS Code"],
  ["vscode-insiders:", "VS Code"],
  ["windsurf:", "Windsurf"],
]);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function recognisedClient(redirectUri) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol === "https:" && HOSTS.has(url.hostname)) return { label: HOSTS.get(url.hostname), kind: "hosted" };
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return { label: "A tool on your own computer", kind: "local" };
  if (SCHEMES.has(url.protocol)) return { label: SCHEMES.get(url.protocol), kind: "desktop" };
  return null;
}

export const UNRECOGNISED_ACK_VALUE = "i-set-this-up";
