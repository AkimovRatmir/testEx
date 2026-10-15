/**
 * One-shot ThingsBoard setup for a fresh instance: `npm run provision`
 * (or `docker compose run --rm provision`).
 *
 * Creates the AHU device profile with its alarm rules, the AHU-1 device and the
 * dashboard from ../thingsboard/*.json, re-pointing the dashboard widgets at the
 * new device, and writes the device access token into the project .env.
 * Safe to run repeatedly: existing entities are found by name and reused.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TB_URL = process.env.TB_URL ?? "http://localhost:8080";
const USERNAME = process.env.TB_USERNAME ?? "tenant@thingsboard.org";
const PASSWORD = process.env.TB_PASSWORD ?? "tenant";
const DEVICE_NAME = process.env.DEVICE_NAME ?? "AHU-1";
const EXPORT_DIR = process.env.TB_EXPORT_DIR ?? resolve(import.meta.dirname, "../../thingsboard");
const ENV_FILE = process.env.ENV_FILE ?? resolve(import.meta.dirname, "../../.env");

type EntityId = { entityType: string; id: string };
type Named = { id: EntityId; name: string };
type Page<T> = { data: T[] };
type Json = Record<string, unknown>;

let token = "";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TB_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { "X-Authorization": `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

const readExport = (file: string) => JSON.parse(readFileSync(resolve(EXPORT_DIR, file), "utf8"));

async function login(): Promise<void> {
  // ThingsBoard needs a minute or two after `docker compose up` before it accepts logins.
  for (let attempt = 1; ; attempt++) {
    try {
      token = (await api<{ token: string }>("POST", "/api/auth/login", { username: USERNAME, password: PASSWORD })).token;
      return;
    } catch (err) {
      if (attempt >= 36) throw err;
      console.log(`waiting for ThingsBoard at ${TB_URL} ...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function ensureProfile(): Promise<EntityId> {
  const profile = readExport("ahu-device-profile.json") as Json & { name: string };
  const search = encodeURIComponent(profile.name);
  const page = await api<Page<Named>>("GET", `/api/deviceProfiles?pageSize=100&page=0&textSearch=${search}`);
  const existing = page.data.find((p) => p.name === profile.name);
  if (existing) {
    console.log(`device profile "${profile.name}" exists`);
    return existing.id;
  }
  const created = await api<Named>("POST", "/api/deviceProfile", profile);
  console.log(`device profile "${profile.name}" created`);
  return created.id;
}

async function ensureAlarmRules(profileId: EntityId): Promise<void> {
  const rules = readExport("ahu-alarm-rules.json") as (Json & { name: string })[];
  const page = await api<Page<Named & { entityId: EntityId }>>("GET", "/api/calculatedFields?pageSize=1000&page=0&types=ALARM");
  const existing = new Set(page.data.filter((f) => f.entityId.id === profileId.id).map((f) => f.name));
  for (const rule of rules) {
    if (existing.has(rule.name)) {
      console.log(`alarm rule "${rule.name}" exists`);
      continue;
    }
    await api("POST", "/api/calculatedField", { ...rule, entityId: profileId });
    console.log(`alarm rule "${rule.name}" created`);
  }
}

async function ensureDevice(profileId: EntityId): Promise<EntityId> {
  let device: (Named & { deviceProfileId: EntityId }) | undefined;
  try {
    device = await api("GET", `/api/tenant/devices?deviceName=${encodeURIComponent(DEVICE_NAME)}`);
  } catch {
    device = undefined; // 404: not created yet
  }
  if (!device) {
    device = await api("POST", "/api/device", { name: DEVICE_NAME, deviceProfileId: profileId });
    console.log(`device "${DEVICE_NAME}" created`);
  } else if (device.deviceProfileId.id !== profileId.id) {
    device = await api("POST", "/api/device", { ...device, deviceProfileId: profileId });
    console.log(`device "${DEVICE_NAME}" switched to the AHU profile`);
  } else {
    console.log(`device "${DEVICE_NAME}" exists`);
  }
  return device!.id;
}

async function ensureDashboard(deviceId: EntityId): Promise<void> {
  // Widgets reference the device by id; swap the exported instance's id for this one.
  let text = readFileSync(resolve(EXPORT_DIR, "ahu-dashboard.json"), "utf8");
  const oldIds = new Set([...text.matchAll(/"deviceId":\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]));
  for (const oldId of oldIds) text = text.replaceAll(oldId, deviceId.id);
  const dashboard = JSON.parse(text) as Json & { title: string };

  const search = encodeURIComponent(dashboard.title);
  const page = await api<Page<{ id: EntityId; title: string }>>("GET", `/api/tenant/dashboards?pageSize=100&page=0&textSearch=${search}`);
  const existing = page.data.find((d) => d.title === dashboard.title);
  if (existing) {
    const current = await api<{ version: number }>("GET", `/api/dashboard/${existing.id.id}`);
    await api("POST", "/api/dashboard", { ...dashboard, id: existing.id, version: current.version });
    console.log(`dashboard "${dashboard.title}" updated`);
  } else {
    await api("POST", "/api/dashboard", dashboard);
    console.log(`dashboard "${dashboard.title}" created`);
  }
}

function writeToken(accessToken: string): void {
  if (!existsSync(ENV_FILE)) {
    console.log(`no ${ENV_FILE}; set TB_DEVICE_TOKEN=${accessToken} yourself`);
    return;
  }
  const env = readFileSync(ENV_FILE, "utf8");
  const line = `TB_DEVICE_TOKEN=${accessToken}`;
  const updated = /^TB_DEVICE_TOKEN=.*$/m.test(env) ? env.replace(/^TB_DEVICE_TOKEN=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
  if (updated !== env) writeFileSync(ENV_FILE, updated);
  console.log(`TB_DEVICE_TOKEN=${accessToken} (${updated !== env ? "written to" : "already in"} .env)`);
}

await login();
const profileId = await ensureProfile();
await ensureAlarmRules(profileId);
const deviceId = await ensureDevice(profileId);
await ensureDashboard(deviceId);
const credentials = await api<{ credentialsId: string }>("GET", `/api/device/${deviceId.id}/credentials`);
writeToken(credentials.credentialsId);
console.log("done: restart the emulator with `docker compose up -d ahu-emulator`");
