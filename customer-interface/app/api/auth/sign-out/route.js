import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  clearCookieOptions,
  selectedWorkspaceCookieName,
  sessionCookieName,
} from "@/src/server/session.mjs";

export const dynamic = "force-dynamic";

export async function POST() {
  const store = await cookies();
  store.set(sessionCookieName, "", clearCookieOptions());
  store.set(selectedWorkspaceCookieName, "", clearCookieOptions());
  redirect("/");
}
