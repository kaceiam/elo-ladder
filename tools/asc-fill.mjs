// Fills in the App Store page for Elo Ladder through the App Store Connect API:
// text, URLs, categories, screenshots, the build and the review notes.
// It does NOT submit for review, and it can't do App Privacy, Age Rating,
// Pricing or the review contact's name/phone (those stay in the website).
//
// Needs: APPSTORE_KEY_ID, APPSTORE_ISSUER_ID, and the .p8 key at APPSTORE_KEY_PATH.
//   node tools/asc-fill.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = JSON.parse(fs.readFileSync(path.join(ROOT, "appstore/metadata.json"), "utf8"));
const API = "https://api.appstoreconnect.apple.com";
const results = [];

function token() {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64u({ alg: "ES256", kid: process.env.APPSTORE_KEY_ID, typ: "JWT" })}.${b64u({ iss: process.env.APPSTORE_ISSUER_ID, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" })}`;
  const sig = crypto.sign("sha256", Buffer.from(data), { key: fs.readFileSync(process.env.APPSTORE_KEY_PATH), dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

async function api(method, url, body) {
  const res = await fetch(url.startsWith("http") ? url : API + url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = (json.errors || []).map((x) => `${x.title}: ${x.detail}`).join("; ");
    throw new Error(`${method} ${url} → ${res.status} ${e}`);
  }
  return json;
}

async function step(label, fn) {
  try { const note = await fn(); results.push(`ok    ${label}${note ? ` (${note})` : ""}`); }
  catch (e) { results.push(`FAIL  ${label}: ${e.message}`); }
}

const editable = (s) => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"].includes(s);

const app = (await api("GET", `/v1/apps?filter[bundleId]=${M.bundleId}`)).data[0];
if (!app) throw new Error("App not found in App Store Connect");
const versions = (await api("GET", `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`)).data;
const version = versions.find((v) => editable(v.attributes.appVersionState || v.attributes.appStoreState));
if (!version) throw new Error("No editable App Store version found");
console.log(`App ${app.attributes.name}, editing version ${version.attributes.versionString}`);

await step(`version number ${M.versionString} and copyright`, () =>
  api("PATCH", `/v1/appStoreVersions/${version.id}`, { data: { type: "appStoreVersions", id: version.id, attributes: { versionString: M.versionString, copyright: M.copyright } } }));

let loc;
await step("description, keywords, promotional text, support and marketing URLs", async () => {
  const locs = (await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  loc = locs.find((l) => l.attributes.locale === M.locale) || locs[0];
  await api("PATCH", `/v1/appStoreVersionLocalizations/${loc.id}`, { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: {
    description: M.description, keywords: M.keywords, promotionalText: M.promotionalText, supportUrl: M.supportUrl, marketingUrl: M.marketingUrl } } });
  return loc.attributes.locale;
});

await step("categories (Games → Board, Education), subtitle and privacy policy URL", async () => {
  const infos = (await api("GET", `/v1/apps/${app.id}/appInfos`)).data;
  const info = infos.find((i) => editable(i.attributes.appStoreState || i.attributes.state)) || infos[0];
  const rel = (id) => ({ data: { type: "appCategories", id } });
  await api("PATCH", `/v1/appInfos/${info.id}`, { data: { type: "appInfos", id: info.id, relationships: {
    primaryCategory: rel(M.primaryCategory), primarySubcategoryOne: rel(M.primarySubcategoryOne), secondaryCategory: rel(M.secondaryCategory) } } });
  const ilocs = (await api("GET", `/v1/appInfos/${info.id}/appInfoLocalizations`)).data;
  const il = ilocs.find((l) => l.attributes.locale === M.locale) || ilocs[0];
  await api("PATCH", `/v1/appInfoLocalizations/${il.id}`, { data: { type: "appInfoLocalizations", id: il.id, attributes: { subtitle: M.subtitle, privacyPolicyUrl: M.privacyPolicyUrl } } });
});

await step("content rights (uses open-source / public-domain content it has rights to)", () =>
  api("PATCH", `/v1/apps/${app.id}`, { data: { type: "apps", id: app.id, attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" } } }));

await step(`attach build ${M.buildNumber}`, async () => {
  const builds = (await api("GET", `/v1/builds?filter[app]=${app.id}&filter[version]=${M.buildNumber}&limit=5`)).data;
  const build = builds[0];
  if (!build) throw new Error("build not found yet (Apple may still be processing it)");
  if (build.attributes.processingState !== "VALID") throw new Error(`build is ${build.attributes.processingState}, try again later`);
  await api("PATCH", `/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: "builds", id: build.id } });
});

await step("review notes and contact email", async () => {
  const attrs = { contactEmail: M.reviewEmail, notes: M.reviewNotes, demoAccountRequired: false };
  let detail = null;
  try { detail = (await api("GET", `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data; } catch { /* none yet */ }
  if (detail) await api("PATCH", `/v1/appStoreReviewDetails/${detail.id}`, { data: { type: "appStoreReviewDetails", id: detail.id, attributes: attrs } });
  else await api("POST", `/v1/appStoreReviewDetails`, { data: { type: "appStoreReviewDetails", attributes: attrs, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } } });
});

await step(`${M.screenshots.length} iPhone screenshots`, async () => {
  if (!loc) throw new Error("no localization");
  const sets = (await api("GET", `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`)).data;
  let set = sets.find((s) => s.attributes.screenshotDisplayType === M.screenshotDisplayType);
  if (!set) set = (await api("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: M.screenshotDisplayType },
    relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
  // Start clean so reruns don't duplicate
  for (const old of (await api("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots`)).data) await api("DELETE", `/v1/appScreenshots/${old.id}`);
  for (const name of M.screenshots) {
    const file = fs.readFileSync(path.join(ROOT, "appstore/screenshots", name));
    const shot = (await api("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: name, fileSize: file.length },
      relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).data;
    for (const op of shot.attributes.uploadOperations) {
      const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
      const res = await fetch(op.url, { method: op.method, headers, body: file.subarray(op.offset, op.offset + op.length) });
      if (!res.ok) throw new Error(`upload of ${name} failed: ${res.status}`);
    }
    await api("PATCH", `/v1/appScreenshots/${shot.id}`, { data: { type: "appScreenshots", id: shot.id, attributes: { uploaded: true, sourceFileChecksum: crypto.createHash("md5").update(file).digest("hex") } } });
  }
});

console.log("\n" + results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exitCode = 1;
