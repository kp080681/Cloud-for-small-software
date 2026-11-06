// OpenAI app/plugin directory domain verification (2026-11-06): serves the
// challenge token from the submission portal as plain text. The token is
// not a secret; it only proves Utplava controls app.utplava.dev.
export const dynamic = "force-dynamic";

export function GET() {
  const token = process.env.OPENAI_APPS_CHALLENGE;
  if (!token || !/^[A-Za-z0-9._-]{8,200}$/.test(token)) return new Response("Not found", { status: 404 });
  return new Response(token, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
