// Custom domains (2026-10-30): a customer connects their own domain (e.g.
// mybakery.com or app.mybakery.com) to an app. Pure functions only: input
// validation, DNS-provider recognition, the records to add/delete, and the
// plain-English status. The provider calls live in
// trigger/manage-custom-domain.ts; the dashboard keeps an identical copy of
// this file in customer-interface/src/shared/control-plane/ (parity-tested).

export class CustomDomainInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CustomDomainInputError";
    this.code = code;
    this.status = 400;
  }
}

// Domains that must never be connected as a customer domain: Utplava's own
// addresses and the hosting provider's. Matching is "equal or a subdomain of".
export const RESERVED_DOMAIN_SUFFIXES = Object.freeze([
  "utplava.dev",
  "vercel.app",
  "vercel.com",
  "vercel.sh",
  "vercel-dns.com",
  "now.sh",
]);

// Special-use and internal names that can't be public websites.
const NON_PUBLIC_SUFFIXES = ["localhost", "local", "internal", "test", "example", "invalid", "onion", "lan", "home", "corp", "intranet"];

export const CUSTOM_DOMAIN_STATUS = Object.freeze({
  PENDING: "PENDING", // saved; Utplava is attaching it
  NEEDS_DNS: "NEEDS_DNS", // attached; waiting for the customer's DNS records
  SECURING: "SECURING", // DNS correct; HTTPS certificate being issued
  ACTIVE: "ACTIVE", // live on the customer's domain
  FAILED: "FAILED", // couldn't be attached; see problem
  REMOVING: "REMOVING",
  REMOVED: "REMOVED",
});

// Accepts what people actually type ("https://www.MyBakery.com/menu",
// "mybakery.com.", "bäckerei.de") and returns the hostname to connect, or
// throws a CustomDomainInputError with a plain-English message.
// A leading "www." is dropped: "www.mybakery.com" connects mybakery.com, and
// www is then set up automatically as a redirect to it.
export function normalizeCustomDomain(input) {
  let text = String(input ?? "").trim();
  if (!text) throw new CustomDomainInputError("DOMAIN_REQUIRED", "Type the domain you want to use, like mybakery.com.");
  if (text.length > 300) throw new CustomDomainInputError("DOMAIN_INVALID", "That domain is too long.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let host;
  try {
    const url = new URL(text);
    if (url.username || url.password || url.port) throw new Error("extra");
    host = url.hostname;
  } catch {
    throw new CustomDomainInputError("DOMAIN_INVALID", "That doesn't look like a domain. Type it like mybakery.com.");
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (/^\[.*\]$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new CustomDomainInputError("DOMAIN_IS_IP", "Use a domain name like mybakery.com, not an IP address.");
  }
  const labels = host.split(".");
  if (labels.length < 2 || host.length > 253) {
    throw new CustomDomainInputError("DOMAIN_INVALID", "That doesn't look like a full domain. Type it like mybakery.com.");
  }
  for (const label of labels) {
    if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label)) {
      throw new CustomDomainInputError("DOMAIN_INVALID", "That doesn't look like a domain. Use only letters, numbers, dots and hyphens.");
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1])) {
    throw new CustomDomainInputError("DOMAIN_INVALID", "That doesn't look like a domain. Type it like mybakery.com.");
  }
  if (NON_PUBLIC_SUFFIXES.includes(labels[labels.length - 1])) {
    throw new CustomDomainInputError("DOMAIN_NOT_PUBLIC", "That isn't a public domain. Use one you've registered, like mybakery.com.");
  }
  if (RESERVED_DOMAIN_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new CustomDomainInputError("DOMAIN_RESERVED", "That address belongs to Utplava or its hosting provider. Use a domain you own.");
  }
  return host;
}

// The other names a connected domain also occupies, so two apps can't end up
// sharing one: an apex domain also brings its www.
export function occupiedNames(domain, includeWww) {
  return includeWww ? [domain, `www.${domain}`] : [domain];
}

// Who runs a domain's DNS, recognised from its nameservers. `steps` tells the
// customer where to click; keep them short and in that provider's own words.
const DNS_PROVIDERS = [
  {
    key: "godaddy",
    name: "GoDaddy",
    match: ["domaincontrol.com"],
    steps: [
      "Sign in at godaddy.com and open My Products.",
      "Next to your domain, click DNS (or Manage DNS).",
      "For each record below, click Add New Record, choose the Type, fill in Name and Value, and Save.",
    ],
  },
  {
    key: "namecheap",
    name: "Namecheap",
    match: ["registrar-servers.com"],
    steps: [
      "Sign in at namecheap.com and open Domain List.",
      "Click Manage next to your domain, then the Advanced DNS tab.",
      "For each record below, click Add New Record, choose the Type, fill in Host and Value, and click the green tick.",
    ],
  },
  {
    key: "hostinger",
    name: "Hostinger",
    match: ["dns-parking.com", "hostinger.com"],
    steps: [
      "Sign in to hPanel at hostinger.com and open Domains.",
      "Choose your domain, then DNS / Nameservers.",
      "For each record below, choose the Type, fill in Name and Points to, and click Add Record.",
    ],
  },
  {
    key: "cloudflare",
    name: "Cloudflare",
    match: ["ns.cloudflare.com"],
    steps: [
      "Sign in at dash.cloudflare.com and choose your domain.",
      "Open DNS, then Records.",
      "For each record below, click Add record, choose the Type, fill in Name and the value.",
      "Set Proxy status to DNS only (grey cloud), then Save. The orange cloud stops the secure lock from being set up.",
    ],
  },
  {
    key: "squarespace",
    name: "Squarespace (formerly Google Domains)",
    match: ["googledomains.com", "squarespacedns.com"],
    steps: [
      "Sign in at account.squarespace.com and open Domains.",
      "Choose your domain, then DNS, then DNS Settings.",
      "For each record below, click Add record, choose the Type, fill in Host and Data, and Save.",
    ],
  },
  {
    key: "porkbun",
    name: "Porkbun",
    match: ["porkbun.com"],
    steps: [
      "Sign in at porkbun.com and open Domain Management.",
      "Click DNS next to your domain.",
      "For each record below, choose the Type, fill in Host and Answer, and click Add.",
    ],
  },
  { key: "route53", name: "Amazon Route 53", match: ["awsdns"], steps: null },
  { key: "wix", name: "Wix", match: ["wixdns.net"], steps: null },
  { key: "hostgator", name: "HostGator", match: ["hostgator.com", "hostgator.in", "websitewelcome.com"], steps: null },
  { key: "bluehost", name: "Bluehost", match: ["bluehost.com", "bluehost.in"], steps: null },
  { key: "bigrock", name: "BigRock", match: ["bigrock.in", "bigrock.com"], steps: null },
  { key: "vercel", name: "Vercel", match: ["vercel-dns.com"], steps: null },
];

const GENERIC_STEPS = [
  "Sign in where you manage your domain (the company you bought it from, or your DNS host).",
  "Open the DNS settings for your domain.",
  "Add each record below exactly as shown, delete any listed for removal, and save.",
];

export function recognizeDnsProvider(nameservers = []) {
  const names = nameservers.map((ns) => String(ns || "").toLowerCase().replace(/\.$/, ""));
  for (const provider of DNS_PROVIDERS) {
    if (names.some((ns) => provider.match.some((suffix) => ns === suffix || ns.endsWith(`.${suffix}`) || ns.includes(suffix)))) {
      return { key: provider.key, name: provider.name, steps: provider.steps ?? GENERIC_STEPS };
    }
  }
  return { key: "unknown", name: null, steps: GENERIC_STEPS };
}

// Steps for a provider recognised earlier (stored by key), so wording fixes
// here reach domains that were set up before them.
export function stepsForProvider(key) {
  const provider = DNS_PROVIDERS.find((candidate) => candidate.key === key);
  return provider?.steps ?? GENERIC_STEPS;
}

// The host label a DNS panel asks for: "@" for the apex itself, otherwise the
// part before the apex ("app" for app.mybakery.com).
export function hostLabel(name, apexName) {
  if (name === apexName) return "@";
  return name.endsWith(`.${apexName}`) ? name.slice(0, -(apexName.length + 1)) : name;
}

export const DEFAULT_APEX_IPV4 = "76.76.21.21";
export const DEFAULT_CNAME_TARGET = "cname.vercel-dns.com";

function firstRanked(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => Number(a?.rank ?? 99) - Number(b?.rank ?? 99))[0];
}

export function recommendedApexIp(config) {
  const value = firstRanked(config?.recommendedIPv4)?.value;
  const ip = Array.isArray(value) ? value[0] : value;
  return typeof ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : DEFAULT_APEX_IPV4;
}

export function recommendedCnameTarget(config) {
  const value = firstRanked(config?.recommendedCNAME)?.value;
  return typeof value === "string" && /^[a-z0-9.-]+$/i.test(value) ? value.replace(/\.$/, "").toLowerCase() : DEFAULT_CNAME_TARGET;
}

// Every value Vercel accepts for this name (any rank), so a correct older
// record isn't flagged for deletion.
function acceptedApexIps(config) {
  const all = (config?.recommendedIPv4 ?? []).flatMap((entry) => (Array.isArray(entry?.value) ? entry.value : [entry?.value]));
  return new Set([DEFAULT_APEX_IPV4, ...all.filter(Boolean)]);
}

function acceptedCnameTargets(config) {
  const all = (config?.recommendedCNAME ?? []).map((entry) => String(entry?.value || "").replace(/\.$/, "").toLowerCase());
  return new Set([DEFAULT_CNAME_TARGET, ...all.filter(Boolean)]);
}

function looksLikeVercelCname(target) {
  return /(^|\.)vercel-dns(-\d+)?\.com$/.test(target);
}

// The records the customer must add, and any existing ones that get in the
// way, for one name (the domain itself or its www).
//   name:     the full name being set up ("mybakery.com", "www.mybakery.com")
//   apexName: the registrable domain ("mybakery.com")
//   config:   Vercel's /v6/domains/{name}/config answer for this project
//   current:  what public DNS says now: { a: [], aaaa: [], cname: [] }
//   redirectTo: set for www, which only needs to reach Vercel (it redirects)
export function recordsForName({ name, apexName, config, current = {} }) {
  const label = hostLabel(name, apexName);
  const isApex = name === apexName;
  const add = [];
  const remove = [];
  const a = (current.a ?? []).map(String);
  const aaaa = (current.aaaa ?? []).map(String);
  const cname = (current.cname ?? []).map((value) => String(value).replace(/\.$/, "").toLowerCase());

  if (isApex) {
    const ip = recommendedApexIp(config);
    const accepted = acceptedApexIps(config);
    if (!a.some((value) => accepted.has(value))) add.push({ type: "A", name: label, value: ip, fqdn: name });
    for (const value of a) if (!accepted.has(value)) remove.push({ type: "A", name: label, value, fqdn: name });
  } else {
    const target = recommendedCnameTarget(config);
    const accepted = acceptedCnameTargets(config);
    const hasGood = cname.some((value) => accepted.has(value) || looksLikeVercelCname(value));
    if (!hasGood) add.push({ type: "CNAME", name: label, value: target, fqdn: name });
    for (const value of cname) if (!accepted.has(value) && !looksLikeVercelCname(value)) remove.push({ type: "CNAME", name: label, value, fqdn: name });
    // An A record on a name that should be a CNAME blocks it. Only judged
    // when there's no CNAME, since resolving A through a CNAME returns the
    // target's addresses.
    if (!cname.length) {
      const acceptedIps = acceptedApexIps(config);
      for (const value of a) if (!acceptedIps.has(value)) remove.push({ type: "A", name: label, value, fqdn: name });
    }
  }
  // An IPv6 address pointing elsewhere sends some visitors to the old site.
  if (!cname.length) for (const value of aaaa) remove.push({ type: "AAAA", name: label, value, fqdn: name });
  return { add, remove };
}

// Ownership records Vercel asks for when the domain is already used in
// another account (verification[] on the project-domain answer).
export function verificationRecords(verification = [], apexName) {
  return (Array.isArray(verification) ? verification : [])
    .filter((item) => item && typeof item.domain === "string" && typeof item.value === "string")
    .map((item) => {
      const fqdn = item.domain.toLowerCase().replace(/\.$/, "");
      return { type: String(item.type || "TXT").toUpperCase(), name: hostLabel(fqdn, apexName), value: item.value, fqdn, purpose: "ownership" };
    });
}

// Ownership proof for a domain that was live in another Utplava workspace:
// a TXT record at _utplava-verify.<domain> holding a value tied to this
// connection request, so it can't be reused for another one.
export const OWNERSHIP_PROOF_PREFIX = "_utplava-verify";
export function ownershipProofValue(domainRowId) {
  return `utplava-verify=${String(domainRowId)}`;
}

// Plain-English status shown to the customer. `primaryConfigured` is
// Vercel's !misconfigured for the main domain; `httpsReachable` is a real
// anonymous request to https://domain succeeding.
export function decideStatus({ verified, primaryConfigured, httpsReachable }) {
  if (!verified || !primaryConfigured) return CUSTOM_DOMAIN_STATUS.NEEDS_DNS;
  if (!httpsReachable) return CUSTOM_DOMAIN_STATUS.SECURING;
  return CUSTOM_DOMAIN_STATUS.ACTIVE;
}

export function statusMessage({ status, domain, providerName, problem }) {
  const where = providerName ? ` in ${providerName}` : "";
  switch (status) {
    case CUSTOM_DOMAIN_STATUS.PENDING:
      return problem || `Connecting ${domain}…`;
    case CUSTOM_DOMAIN_STATUS.NEEDS_DNS:
      return problem || `Add the records below${where}. Utplava checks automatically; changes usually show up within minutes, sometimes a few hours.`;
    case CUSTOM_DOMAIN_STATUS.SECURING:
      return `Found it. Setting up the secure https lock for ${domain}; this usually takes a minute or two.`;
    case CUSTOM_DOMAIN_STATUS.ACTIVE:
      return `Live at ${domain}.`;
    case CUSTOM_DOMAIN_STATUS.FAILED:
      return problem || `Utplava couldn't connect ${domain}.`;
    case CUSTOM_DOMAIN_STATUS.REMOVING:
      return `Removing ${domain}…`;
    default:
      return "";
  }
}
