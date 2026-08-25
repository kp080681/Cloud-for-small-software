export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    service: "ssc-spike-a-test-app",
    marker: process.env.APP_BUILD_MARKER ?? null,
  });
}
