export function safeErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  return Response.json({ error: code }, { status });
}
