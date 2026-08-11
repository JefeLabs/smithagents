// ---------------------------------------------------------------------------
// device-registry.ts — pairing codes + device tokens for remote workers
//
// The registry is the writer remoteWorkers never had: an operator mints a
// short-lived pairing code (UI/curl), the desktop redeems it once for a
// long-lived device token, and /workers/connect authenticates against the
// stored hash. Tokens are stored sha256-hashed — the raw token exists only
// in the redeem response and the worker's credentials file.
// ---------------------------------------------------------------------------
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DeviceRecord {
  deviceId: string;
  name: string;
  /** sha256 hex of the device token — never the token itself */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
}

interface PendingCode {
  /** sha256 hex of the normalized code */
  codeHash: string;
  expiresAt: number;
}

/** No I/L/O/0/1 — every character survives being read aloud or retyped. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const DEFAULT_CODE_TTL_MS = 10 * 60_000;
const TOKEN_PREFIX = "smith-device-";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export class DeviceRegistry {
  private devices: DeviceRecord[] = [];
  private readonly pending: PendingCode[] = [];

  constructor(private readonly filePath: string) {}

  /** Read devices.json if present; a missing file means an empty registry. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { devices?: DeviceRecord[] };
      this.devices = Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
      this.devices = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ devices: this.devices }, null, 2));
  }

  mintPairingCode(ttlMs = DEFAULT_CODE_TTL_MS, now = Date.now()): { code: string; expiresAt: number } {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const display = `${code.slice(0, 4)}-${code.slice(4)}`;
    const expiresAt = now + ttlMs;
    this.pending.push({ codeHash: sha256(code).toString("hex"), expiresAt });
    return { code: display, expiresAt };
  }

  /** Single-use: a matching code is consumed whether or not anything follows. */
  async redeem(code: string, name: string, now = Date.now()): Promise<{ deviceId: string; token: string } | null> {
    const presented = sha256(normalizeCode(code));
    const idx = this.pending.findIndex((p) => timingSafeEqual(presented, Buffer.from(p.codeHash, "hex")));
    if (idx === -1) return null;
    const [entry] = this.pending.splice(idx, 1);
    if (now > entry.expiresAt) return null;

    const token = TOKEN_PREFIX + randomBytes(32).toString("hex");
    const device: DeviceRecord = {
      deviceId: `device-${randomUUID().slice(0, 8)}`,
      name,
      tokenHash: sha256(token).toString("hex"),
      createdAt: new Date(now).toISOString(),
    };
    this.devices.push(device);
    await this.persist();
    return { deviceId: device.deviceId, token };
  }

  async verifyToken(token: string): Promise<DeviceRecord | null> {
    const presented = sha256(token);
    for (const device of this.devices) {
      if (device.revoked) continue;
      if (timingSafeEqual(presented, Buffer.from(device.tokenHash, "hex"))) return device;
    }
    return null;
  }

  list(): DeviceRecord[] {
    return [...this.devices];
  }

  async revoke(deviceId: string): Promise<boolean> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (!device) return false;
    device.revoked = true;
    await this.persist();
    return true;
  }

  async touch(deviceId: string): Promise<void> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (!device) return;
    device.lastSeenAt = new Date().toISOString();
    await this.persist();
  }
}
