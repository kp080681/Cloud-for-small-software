// "Connect your services" (2026-11-04): plain-English help for the settings
// an app needs from popular services (payments, email, sign-in, AI), so a
// person who built an app with an AI tool knows what each key is, where to
// find it, and whether what they pasted looks right.
//
// Used by the dashboard (in the browser, as someone types) and by the MCP
// tools (so an assistant can explain the same thing). Pure functions only:
// nothing here sees a saved secret, calls a service or stores anything. The
// format checks only warn, never block, because providers change formats.
//
// Setting names come from the customer's repository, so they only ever
// select from the fixed text below; no part of a name is echoed into help.

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_)/;
const SECRET_WORDS = /(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|_TOKEN$)/;

const SERVICES = {
  stripe: {
    name: "Stripe",
    followUp:
      "To know when someone has paid, add a webhook in Stripe (Developers, then Webhooks) pointing at your app's live link, and save its signing secret as a setting.",
    followUpUrl: "https://dashboard.stripe.com/webhooks",
  },
  razorpay: {
    name: "Razorpay",
    followUp:
      "Test keys (rzp_test_) never take real money. For real payments, finish activating your Razorpay account and switch to the live keys.",
    followUpUrl: "https://dashboard.razorpay.com",
  },
  resend: {
    name: "Resend",
    followUp:
      "Until you verify a domain, Resend only sends emails to your own address. Add your domain in Resend under Domains so your users receive them.",
    followUpUrl: "https://resend.com/domains",
  },
  clerk: {
    name: "Clerk",
    followUp:
      "Test keys work on your live link but show a development banner and have limits. For real users, create a production instance in Clerk, which needs your own domain.",
    followUpUrl: "https://dashboard.clerk.com",
  },
  supabase: {
    name: "Supabase",
    followUp:
      "If your app has sign-in, add your app's live link in Supabase under Authentication, then URL Configuration (Site URL and Redirect URLs). Otherwise sign-in sends people back to localhost.",
    followUpUrl: "https://supabase.com/dashboard/project/_/auth/url-configuration",
  },
  openai: {
    name: "OpenAI",
    followUp: "Set a monthly spending limit in OpenAI's billing settings, so a busy day can't run up a large bill.",
    followUpUrl: "https://platform.openai.com/settings/organization/limits",
  },
  anthropic: {
    name: "Anthropic",
    followUp: "Set a monthly spending limit in the Anthropic Console, so a busy day can't run up a large bill.",
    followUpUrl: "https://console.anthropic.com/settings/limits",
  },
};

// Names are matched after removing a public prefix (NEXT_PUBLIC_, VITE_ ...).
const GUIDES = [
  {
    service: "stripe",
    names: ["STRIPE_SECRET_KEY", "STRIPE_SECRET", "STRIPE_API_KEY", "STRIPE_KEY", "STRIPE_PRIVATE_KEY"],
    what: "Your Stripe secret key, used by your app's server to take payments.",
    where: "Stripe dashboard, then Developers, then API keys",
    url: "https://dashboard.stripe.com/apikeys",
    secret: true,
    prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"],
    looksLike: "It starts with sk_live_ or sk_test_.",
    wrong: [{ prefix: "pk_", message: "That looks like the publishable key (pk_). This setting needs the secret key, which starts with sk_." },
            { prefix: "whsec_", message: "That looks like a webhook signing secret (whsec_). This setting needs the secret API key, which starts with sk_." }],
  },
  {
    service: "stripe",
    names: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLIC_KEY", "STRIPE_PK"],
    what: "Your Stripe publishable key, used in the browser to show the payment form. It's safe to be public.",
    where: "Stripe dashboard, then Developers, then API keys",
    url: "https://dashboard.stripe.com/apikeys",
    secret: false,
    prefixes: ["pk_live_", "pk_test_"],
    looksLike: "It starts with pk_live_ or pk_test_.",
    wrong: [{ prefix: "sk_", message: "That's a secret key (sk_). Never put it here: this setting can be seen by every visitor. Use the publishable key, which starts with pk_." },
            { prefix: "rk_", message: "That's a restricted secret key (rk_). Never put it here: this setting can be seen by every visitor. Use the publishable key, which starts with pk_." }],
  },
  {
    service: "stripe",
    names: ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SIGNING_SECRET", "STRIPE_ENDPOINT_SECRET"],
    what: "The signing secret Stripe gives you when you add a webhook. Your app uses it to check that payment notices really come from Stripe.",
    where: "Stripe dashboard, then Developers, then Webhooks, then your webhook, then Signing secret",
    url: "https://dashboard.stripe.com/webhooks",
    secret: true,
    prefixes: ["whsec_"],
    looksLike: "It starts with whsec_.",
    wrong: [{ prefix: "sk_", message: "That's your Stripe secret API key (sk_), not the webhook signing secret. The signing secret starts with whsec_." }],
  },
  {
    service: "razorpay",
    names: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY", "RAZORPAY_ID"],
    what: "Your Razorpay key ID, used to open the Razorpay checkout. It's safe to be public.",
    where: "Razorpay dashboard, then Account & Settings, then API Keys",
    url: "https://dashboard.razorpay.com",
    secret: false,
    prefixes: ["rzp_live_", "rzp_test_"],
    looksLike: "It starts with rzp_live_ or rzp_test_.",
    wrong: [],
  },
  {
    service: "razorpay",
    names: ["RAZORPAY_KEY_SECRET", "RAZORPAY_SECRET", "RAZORPAY_SECRET_KEY"],
    what: "Your Razorpay key secret, used by your app's server to create and confirm payments.",
    where: "Razorpay dashboard, then Account & Settings, then API Keys (shown once, when you generate the key)",
    url: "https://dashboard.razorpay.com",
    secret: true,
    prefixes: [],
    looksLike: "It's a mix of letters and numbers, with no rzp_ at the start.",
    wrong: [{ prefix: "rzp_", message: "That looks like the key ID (rzp_). This setting needs the key secret, which Razorpay shows next to it when you generate the key." }],
  },
  {
    service: "razorpay",
    names: ["RAZORPAY_WEBHOOK_SECRET"],
    what: "The secret you chose when adding a webhook in Razorpay. Your app uses it to check that payment notices really come from Razorpay.",
    where: "Razorpay dashboard, then Account & Settings, then Webhooks",
    url: "https://dashboard.razorpay.com",
    secret: true,
    prefixes: [],
    looksLike: "It's whatever you typed as the secret when you created the webhook.",
    wrong: [],
  },
  {
    service: "resend",
    names: ["RESEND_API_KEY", "RESEND_KEY", "RESEND_TOKEN"],
    what: "Your Resend API key, used to send emails such as sign-up confirmations and password resets.",
    where: "Resend, then API Keys",
    url: "https://resend.com/api-keys",
    secret: true,
    prefixes: ["re_"],
    looksLike: "It starts with re_.",
    wrong: [],
  },
  {
    service: "clerk",
    names: ["CLERK_SECRET_KEY", "CLERK_API_KEY"],
    what: "Your Clerk secret key, used by your app's server to check who is signed in.",
    where: "Clerk dashboard, then your app, then API keys",
    url: "https://dashboard.clerk.com",
    secret: true,
    prefixes: ["sk_live_", "sk_test_"],
    looksLike: "It starts with sk_live_ or sk_test_.",
    wrong: [{ prefix: "pk_", message: "That looks like the publishable key (pk_). This setting needs the secret key, which starts with sk_." }],
  },
  {
    service: "clerk",
    names: ["CLERK_PUBLISHABLE_KEY"],
    what: "Your Clerk publishable key, used in the browser to show the sign-in form. It's safe to be public.",
    where: "Clerk dashboard, then your app, then API keys",
    url: "https://dashboard.clerk.com",
    secret: false,
    prefixes: ["pk_live_", "pk_test_"],
    looksLike: "It starts with pk_live_ or pk_test_.",
    wrong: [{ prefix: "sk_", message: "That's the secret key (sk_). Never put it here: this setting can be seen by every visitor. Use the publishable key, which starts with pk_." }],
  },
  {
    service: "supabase",
    names: ["SUPABASE_URL"],
    what: "Your Supabase project's address. It's safe to be public.",
    where: "Supabase dashboard, then your project, then Project Settings, then API",
    url: "https://supabase.com/dashboard/project/_/settings/api",
    secret: false,
    prefixes: ["https://"],
    looksLike: "It looks like https://abcdefgh.supabase.co",
    wrong: [{ prefix: "eyJ", message: "That looks like a key, not the project address. The address looks like https://abcdefgh.supabase.co" },
            { prefix: "postgres", message: "That's the database connection string. This setting needs the project address, which looks like https://abcdefgh.supabase.co" }],
  },
  {
    service: "supabase",
    names: ["SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_KEY", "SUPABASE_PUBLIC_KEY"],
    what: "Your Supabase anon (publishable) key, used in the browser. It's safe to be public as long as your tables have Row Level Security turned on.",
    where: "Supabase dashboard, then your project, then Project Settings, then API Keys",
    url: "https://supabase.com/dashboard/project/_/settings/api-keys",
    secret: false,
    prefixes: ["eyJ", "sb_publishable_"],
    looksLike: "It starts with sb_publishable_, or with eyJ for older projects.",
    wrong: [{ prefix: "sb_secret_", message: "That's a secret key (sb_secret_). Never put it here: this setting can be seen by every visitor. Use the publishable or anon key." }],
  },
  {
    service: "supabase",
    names: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE"],
    what: "Your Supabase service role (secret) key. It can read and change everything in your project, so it must only be used in server code.",
    where: "Supabase dashboard, then your project, then Project Settings, then API Keys",
    url: "https://supabase.com/dashboard/project/_/settings/api-keys",
    secret: true,
    prefixes: ["eyJ", "sb_secret_"],
    looksLike: "It starts with sb_secret_, or with eyJ for older projects.",
    wrong: [{ prefix: "sb_publishable_", message: "That's the publishable key. This setting needs the secret (service role) key." }],
  },
  {
    service: "openai",
    names: ["OPENAI_API_KEY", "OPENAI_KEY"],
    what: "Your OpenAI API key, used by your app's server to call ChatGPT models.",
    where: "OpenAI platform, then API keys",
    url: "https://platform.openai.com/api-keys",
    secret: true,
    prefixes: ["sk-"],
    looksLike: "It starts with sk-",
    wrong: [{ prefix: "sk-ant-", message: "That's an Anthropic key (sk-ant-), not an OpenAI key." }],
  },
  {
    service: "anthropic",
    names: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    what: "Your Anthropic API key, used by your app's server to call Claude.",
    where: "Anthropic Console, then API keys",
    url: "https://console.anthropic.com/settings/keys",
    secret: true,
    prefixes: ["sk-ant-"],
    looksLike: "It starts with sk-ant-",
    wrong: [],
  },
];

const BY_NAME = new Map();
for (const guide of GUIDES) for (const name of guide.names) BY_NAME.set(name, guide);

export function isPublicSettingName(envKey) {
  return PUBLIC_PREFIX.test(String(envKey || ""));
}

function baseName(envKey) {
  return String(envKey || "").toUpperCase().replace(PUBLIC_PREFIX, "");
}

// A secret key in a setting whose name makes the build send it to browsers.
function exposureWarning(envKey, guide) {
  if (!isPublicSettingName(envKey)) return null;
  const looksSecret = guide ? guide.secret : SECRET_WORDS.test(baseName(envKey));
  if (!looksSecret) return null;
  return "This setting's name starts with a public prefix (like NEXT_PUBLIC_ or VITE_), so its value is sent to every visitor's browser, where anyone can copy it. A secret must only be used in server code: ask your AI tool to move it to a name without that prefix.";
}

export function serviceGuideFor(envKey) {
  const guide = BY_NAME.get(baseName(envKey));
  const exposed = exposureWarning(envKey, guide);
  if (!guide) return exposed ? { service: null, serviceName: null, exposedWarning: exposed } : null;
  return {
    service: guide.service,
    serviceName: SERVICES[guide.service].name,
    what: guide.what,
    where: guide.where,
    url: guide.url,
    looksLike: guide.looksLike,
    secret: guide.secret,
    exposedWarning: exposed,
  };
}

// Checks what someone is about to paste. Returns notes to show, never throws
// and never blocks: an empty list means nothing looked wrong.
export function checkServiceValue(envKey, rawValue) {
  const value = typeof rawValue === "string" ? rawValue : "";
  if (!value) return [];
  const notes = [];
  if (value !== value.trim()) notes.push({ level: "warning", message: "There's a space at the start or end. Remove it, or the key won't work." });
  const trimmed = value.trim();
  if (/^["'`].*["'`]$/.test(trimmed)) notes.push({ level: "warning", message: "Remove the quote marks around the value. Paste only the key itself." });
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) notes.push({ level: "warning", message: "It looks like you pasted the whole line (NAME=value). Paste only the part after the = sign." });

  const guide = BY_NAME.get(baseName(envKey));
  if (!guide) return notes;
  const bare = trimmed.replace(/^["'`]|["'`]$/g, "");
  const wrong = guide.wrong.find((item) => bare.startsWith(item.prefix));
  if (wrong) {
    notes.push({ level: "warning", message: wrong.message });
  } else if (guide.prefixes.length && !guide.prefixes.some((prefix) => bare.startsWith(prefix))) {
    notes.push({ level: "warning", message: `This doesn't look like a ${SERVICES[guide.service].name} key. ${guide.looksLike}` });
  }
  if (guide.service === "supabase" && guide.names.includes("SUPABASE_URL") && bare.startsWith("https://") && !/\.supabase\.(co|in)\/?$/.test(bare)) {
    notes.push({ level: "warning", message: "Supabase project addresses usually end in .supabase.co. Check you copied the Project URL." });
  }
  if (/^(sk|pk|rk)_test_|^rzp_test_/.test(bare)) {
    notes.push({ level: "note", message: "This is a test key: it works, but no real money moves and some features are limited. Switch to the live key when you're ready for real users." });
  }
  return notes;
}

// The one extra step each detected service needs once the app is live.
export function serviceFollowUps(envKeys = []) {
  const seen = new Set();
  for (const key of envKeys) {
    const guide = BY_NAME.get(baseName(key));
    if (guide) seen.add(guide.service);
  }
  return [...seen].sort().map((id) => ({
    service: id,
    serviceName: SERVICES[id].name,
    message: SERVICES[id].followUp,
    url: SERVICES[id].followUpUrl,
  }));
}
