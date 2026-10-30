import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_DOMAIN_STATUS as S,
  CustomDomainInputError,
  decideStatus,
  hostLabel,
  normalizeCustomDomain,
  recognizeDnsProvider,
  recommendedApexIp,
  recommendedCnameTarget,
  recordsForName,
  statusMessage,
  verificationRecords,
} from "../src/custom-domain.mjs";

test("normalizes what people actually type", () => {
  assert.equal(normalizeCustomDomain("mybakery.com"), "mybakery.com");
  assert.equal(normalizeCustomDomain("  MyBakery.COM.  "), "mybakery.com");
  assert.equal(normalizeCustomDomain("https://www.mybakery.com/menu?x=1"), "mybakery.com");
  assert.equal(normalizeCustomDomain("www.mybakery.co.in"), "mybakery.co.in");
  assert.equal(normalizeCustomDomain("app.mybakery.com"), "app.mybakery.com");
  assert.equal(normalizeCustomDomain("bäckerei.de"), "xn--bckerei-5wa.de");
});

test("refuses things that aren't a public domain the customer could own", () => {
  const bad = ["", "   ", "mybakery", "192.168.1.10", "http://[::1]/", "localhost", "shop.local", "my_bakery.com", "-bad.com", "a.123",
    "user:pass@mybakery.com", "mybakery.com:8080", "x".repeat(64) + ".com"];
  for (const input of bad) assert.throws(() => normalizeCustomDomain(input), CustomDomainInputError, JSON.stringify(input));
});

test("refuses Utplava's and the hosting provider's own addresses", () => {
  for (const input of ["utplava.dev", "app.utplava.dev", "evil.utplava.dev", "x.vercel.app", "vercel.com", "foo.vercel-dns.com"]) {
    assert.throws(() => normalizeCustomDomain(input), (e) => e.code === "DOMAIN_RESERVED", input);
  }
  assert.equal(normalizeCustomDomain("notutplava.dev"), "notutplava.dev");
});

test("recognises common DNS providers from nameservers", () => {
  assert.equal(recognizeDnsProvider(["ns51.domaincontrol.com.", "ns52.domaincontrol.com"]).key, "godaddy");
  assert.equal(recognizeDnsProvider(["dns1.registrar-servers.com"]).key, "namecheap");
  assert.equal(recognizeDnsProvider(["ns1.dns-parking.com"]).key, "hostinger");
  assert.equal(recognizeDnsProvider(["ada.ns.cloudflare.com"]).key, "cloudflare");
  assert.equal(recognizeDnsProvider(["ns-cloud-a1.googledomains.com"]).key, "squarespace");
  assert.equal(recognizeDnsProvider(["ns-123.awsdns-15.com"]).key, "route53");
  const unknown = recognizeDnsProvider(["ns1.somewhere.example"]);
  assert.equal(unknown.key, "unknown");
  assert.equal(unknown.name, null);
  assert.ok(unknown.steps.length >= 2);
  assert.ok(recognizeDnsProvider([]).steps.length >= 2);
});

test("host labels are what DNS panels ask for", () => {
  assert.equal(hostLabel("mybakery.com", "mybakery.com"), "@");
  assert.equal(hostLabel("www.mybakery.com", "mybakery.com"), "www");
  assert.equal(hostLabel("app.shop.mybakery.co.in", "mybakery.co.in"), "app.shop");
});

const config = {
  misconfigured: true,
  recommendedIPv4: [{ rank: 2, value: ["76.76.21.21"] }, { rank: 1, value: ["216.198.79.1"] }],
  recommendedCNAME: [{ rank: 2, value: "cname.vercel-dns.com." }, { rank: 1, value: "abc123.vercel-dns-017.com." }],
};

test("uses the provider's top-ranked values, with safe defaults", () => {
  assert.equal(recommendedApexIp(config), "216.198.79.1");
  assert.equal(recommendedCnameTarget(config), "abc123.vercel-dns-017.com");
  assert.equal(recommendedApexIp(null), "76.76.21.21");
  assert.equal(recommendedCnameTarget({ recommendedCNAME: [{ rank: 1, value: "bad value!" }] }), "cname.vercel-dns.com");
});

test("apex domain pointing at an old host: add the A record, delete the old ones", () => {
  const { add, remove } = recordsForName({
    name: "mybakery.com",
    apexName: "mybakery.com",
    config,
    current: { a: ["185.10.10.10"], aaaa: ["2a02:4780::1"], cname: [] },
  });
  assert.deepEqual(add, [{ type: "A", name: "@", value: "216.198.79.1", fqdn: "mybakery.com" }]);
  assert.deepEqual(remove.map((r) => [r.type, r.value]), [["A", "185.10.10.10"], ["AAAA", "2a02:4780::1"]]);
});

test("apex already on an accepted address needs nothing added", () => {
  const { add, remove } = recordsForName({ name: "mybakery.com", apexName: "mybakery.com", config, current: { a: ["76.76.21.21"] } });
  assert.deepEqual(add, []);
  assert.deepEqual(remove, []);
});

test("subdomain: CNAME to the recommended target; a stray A record is flagged", () => {
  const fresh = recordsForName({ name: "app.mybakery.com", apexName: "mybakery.com", config, current: { a: ["185.10.10.10"] } });
  assert.deepEqual(fresh.add, [{ type: "CNAME", name: "app", value: "abc123.vercel-dns-017.com", fqdn: "app.mybakery.com" }]);
  assert.deepEqual(fresh.remove.map((r) => r.type), ["A"]);

  const wrongCname = recordsForName({ name: "www.mybakery.com", apexName: "mybakery.com", config, current: { cname: ["mybakery.wixdns.net."], a: ["1.2.3.4"] } });
  assert.equal(wrongCname.add[0].name, "www");
  assert.deepEqual(wrongCname.remove.map((r) => [r.type, r.value]), [["CNAME", "mybakery.wixdns.net"]]);

  const good = recordsForName({ name: "app.mybakery.com", apexName: "mybakery.com", config, current: { cname: ["cname.vercel-dns.com."], a: ["76.76.21.21"] } });
  assert.deepEqual(good, { add: [], remove: [] });
});

test("ownership records become relative TXT names", () => {
  const records = verificationRecords([{ type: "TXT", domain: "_vercel.mybakery.com", value: "vc-domain-verify=mybakery.com,abc", reason: "pending_domain_verification" }, { junk: true }], "mybakery.com");
  assert.deepEqual(records, [{ type: "TXT", name: "_vercel", value: "vc-domain-verify=mybakery.com,abc", fqdn: "_vercel.mybakery.com", purpose: "ownership" }]);
  assert.deepEqual(verificationRecords(null, "mybakery.com"), []);
});

test("status follows ownership, DNS, then a real HTTPS request", () => {
  assert.equal(decideStatus({ verified: false, primaryConfigured: true, httpsReachable: true }), S.NEEDS_DNS);
  assert.equal(decideStatus({ verified: true, primaryConfigured: false, httpsReachable: false }), S.NEEDS_DNS);
  assert.equal(decideStatus({ verified: true, primaryConfigured: true, httpsReachable: false }), S.SECURING);
  assert.equal(decideStatus({ verified: true, primaryConfigured: true, httpsReachable: true }), S.ACTIVE);
});

test("status messages are plain and name the provider", () => {
  assert.match(statusMessage({ status: S.NEEDS_DNS, domain: "mybakery.com", providerName: "GoDaddy" }), /in GoDaddy/);
  assert.equal(statusMessage({ status: S.ACTIVE, domain: "mybakery.com" }), "Live at mybakery.com.");
  assert.equal(statusMessage({ status: S.FAILED, domain: "x.com", problem: "Nope." }), "Nope.");
});
