"use client";

// The ONLY place the dashboard touches browser storage (2026-11-09).
// It holds a signed-out visitor's draft (a pasted page, or a repository
// name they checked) across the sign-in redirect, for at most a day.
// It never holds anything about who someone is: sign-in state lives only
// in the server's sealed session cookie. Enforced by
// test/customer-interface-boundary.test.mjs.

export const DRAFT_PAGE = "utplava_try_page";
export const DRAFT_REPO = "utplava_try_repo";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveDraft(key, value) {
  try {
    store()?.setItem(key, JSON.stringify({ ...value, savedAt: Date.now() }));
    return Boolean(store());
  } catch {
    return false;
  }
}

export function readDraft(key) {
  try {
    const value = JSON.parse(store()?.getItem(key) || "null");
    if (!value || Date.now() - Number(value.savedAt || 0) > MAX_AGE_MS) {
      store()?.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function forgetDraft(key) {
  try {
    store()?.removeItem(key);
  } catch {
    // nothing to do
  }
}
