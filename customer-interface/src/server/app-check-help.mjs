// Optional "help me fix this" requests from the App safety check results.
// Stores only what the person chose to send, and emails the founder.

import { sendOwnerAlert } from "./owner-alerts.mjs";
import { normalizeTarget } from "./app-check.mjs";

export class HelpRequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function validateHelpRequest(body) {
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email || email.length > 200 || !/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/i.test(email)) {
    throw new HelpRequestError("Enter an email address like you@example.com.");
  }
  let target;
  try {
    target = normalizeTarget(body?.url).origin;
  } catch {
    throw new HelpRequestError("Run a check first, then ask for help with it.");
  }
  const rawScore = Number(body?.score);
  const score = Number.isInteger(rawScore) && rawScore >= 0 && rawScore <= 10 ? rawScore : null;
  return { email, target, score };
}

export async function saveHelpRequest(db, request, { alert = sendOwnerAlert } = {}) {
  await db.query(
    `INSERT INTO public_check_help_requests (email, target, score) VALUES ($1, $2, $3)`,
    [request.email, request.target, request.score],
  );
  await alert({
    subject: `Safety check: ${request.email} wants help with ${request.target}`,
    text: [
      `${request.email} asked for help fixing what the App safety check found.`,
      "",
      `App: ${request.target}`,
      `Score: ${request.score ?? "?"}/10`,
      `Their results: https://utplava.dev/check/?url=${encodeURIComponent(request.target)}`,
      "",
      "Reply to them directly from your own email.",
    ].join("\n"),
  }).catch(() => {});
  return { ok: true };
}
