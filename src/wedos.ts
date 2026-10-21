import { createHash, randomUUID } from 'node:crypto';
import { CaddyshipError } from './util.js';

export const WAPI_ENDPOINT = 'https://api.wedos.com/wapi/json';

export const sha1 = (s: string): string => createHash('sha1').update(s, 'utf8').digest('hex');

/** WAPI wants the current hour (00-23) in Europe/Prague, whatever the local zone is. */
export function pragueHour(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
}

/** auth = sha1(login + sha1(wapiPassword) + HH) */
export function wapiAuth(login: string, passwordSha1: string, now: Date = new Date()): string {
  return sha1(`${login}${passwordSha1}${pragueHour(now)}`);
}

export class WapiError extends CaddyshipError {
  constructor(
    message: string,
    public code?: number,
    hint?: string,
  ) {
    super(message, hint);
    this.name = 'WapiError';
  }
}

/** An address record for this name exists but points somewhere else. */
export class DnsConflictError extends CaddyshipError {
  constructor(
    public fqdn: string,
    public type: string,
    public existing: string,
  ) {
    super(
      `${fqdn} already has an ${type} record pointing to ${existing}.`,
      'Choose to update it, or pick another subdomain.',
    );
    this.name = 'DnsConflictError';
  }
}

export interface DnsRow {
  id: string;
  name: string;
  type: string;
  rdata: string;
  ttl: number;
}

export interface WapiOptions {
  login: string;
  passwordSha1: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

const AUTH_HINT =
  'Check that you use the WAPI password (not your account password), that WAPI is enabled, ' +
  "and that this machine's public IP is on the WAPI allow-list in the WEDOS customer panel.";

export class WapiClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly o: WapiOptions) {
    // CADDYSHIP_WAPI_ENDPOINT exists for development against a mock server only.
    this.endpoint = o.endpoint ?? process.env.CADDYSHIP_WAPI_ENDPOINT ?? WAPI_ENDPOINT;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? (() => new Date());
  }

  /** Low-level call. Returns the `data` object of a successful response. */
  async call(command: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sentAt = this.now();
      const payload = {
        request: {
          user: this.o.login,
          auth: wapiAuth(this.o.login, this.o.passwordSha1, sentAt),
          clTRID: `caddyship-${randomUUID()}`,
          command,
          ...(data ? { data } : {}),
        },
      };

      let res: Response;
      try {
        res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ request: JSON.stringify(payload) }).toString(),
        });
      } catch (e) {
        throw new WapiError(`Could not reach WEDOS WAPI: ${(e as Error).message}`);
      }
      if (!res.ok) throw new WapiError(`WEDOS WAPI answered HTTP ${res.status}`);

      let json: { response?: { code?: number; result?: string; data?: Record<string, unknown> } };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        throw new WapiError('WEDOS WAPI returned a response that is not JSON');
      }
      const r = json.response;
      if (!r || typeof r.code !== 'number') throw new WapiError('Unexpected WAPI response shape');
      if (r.code === 1000 || r.code === 1001) return r.data ?? {};

      // The auth hash embeds the hour; if it rolled over mid-request, retry once.
      if (attempt === 0 && pragueHour(sentAt) !== pragueHour(this.now())) continue;

      const text = r.result ?? 'unknown error';
      const authish = /auth|ip|denied|forbidden|password|login|permission/i.test(text);
      throw new WapiError(`WAPI ${command} failed (${r.code}): ${text}`, r.code, authish ? AUTH_HINT : undefined);
    }
    throw new WapiError('WAPI request failed');
  }

  async listDomains(): Promise<string[]> {
    const d = await this.call('dns-domains-list');
    return asArray<unknown>(d.domain)
      .map((x) => {
        if (typeof x === 'string') return x;
        const o = x as { name?: unknown; domain?: unknown };
        return String(o.name ?? o.domain ?? '');
      })
      .filter(Boolean)
      .map((s) => s.toLowerCase())
      .sort();
  }

  async listRows(domain: string): Promise<DnsRow[]> {
    const d = await this.call('dns-rows-list', { domain });
    return asArray<Record<string, unknown>>(d.row as Record<string, unknown> | Record<string, unknown>[]).map(
      (r) => ({
        id: String(r.ID ?? r.id ?? ''),
        name: String(r.name ?? ''),
        type: String(r.rdtype ?? r.type ?? '').toUpperCase(),
        rdata: String(r.rdata ?? ''),
        ttl: Number(r.ttl ?? 0),
      }),
    );
  }

  async addRow(
    domain: string,
    row: { name: string; type: string; rdata: string; ttl: number; comment?: string },
  ): Promise<void> {
    await this.call('dns-row-add', {
      domain,
      name: row.name,
      ttl: row.ttl,
      type: row.type,
      rdata: row.rdata,
      auth_comment: row.comment ?? 'created by caddyship',
    });
  }

  async updateRow(
    domain: string,
    rowId: string,
    row: { rdata: string; ttl: number; comment?: string },
  ): Promise<void> {
    await this.call('dns-row-update', {
      domain,
      row_id: rowId,
      ttl: row.ttl,
      rdata: row.rdata,
      auth_comment: row.comment ?? 'updated by caddyship',
    });
  }

  async deleteRow(domain: string, rowId: string): Promise<void> {
    await this.call('dns-row-delete', { domain, row_id: rowId });
  }

  async commit(domain: string): Promise<void> {
    await this.call('dns-domain-commit', { name: domain });
  }
}

export type DnsOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Make sure `<sub>.<zone>` has exactly the wanted A/AAAA record.
 * Never touches records it did not match by name+type, and refuses to
 * create an address record next to a CNAME.
 */
export async function ensureAddressRecord(
  client: WapiClient,
  zone: string,
  sub: string,
  type: 'A' | 'AAAA',
  ip: string,
  ttl: number,
  onConflict: 'update' | 'abort' = 'abort',
): Promise<DnsOutcome> {
  const rows = await client.listRows(zone);
  const same = rows.filter((r) => r.name === sub);
  if (same.some((r) => r.type === 'CNAME')) {
    throw new CaddyshipError(
      `${sub}.${zone} already has a CNAME record.`,
      'Remove or change the CNAME in the WEDOS panel first; it cannot coexist with an A/AAAA record.',
    );
  }
  const existing = same.find((r) => r.type === type);
  if (existing) {
    if (existing.rdata === ip) return 'unchanged';
    if (onConflict === 'abort') throw new DnsConflictError(`${sub}.${zone}`, type, existing.rdata);
    await client.updateRow(zone, existing.id, { rdata: ip, ttl });
    await client.commit(zone);
    return 'updated';
  }
  await client.addRow(zone, { name: sub, type, rdata: ip, ttl });
  await client.commit(zone);
  return 'created';
}

/** Delete matching address records; returns how many were removed. */
export async function removeAddressRecord(
  client: WapiClient,
  zone: string,
  sub: string,
  type: string,
  ip?: string,
): Promise<number> {
  const rows = await client.listRows(zone);
  const hits = rows.filter((r) => r.name === sub && r.type === type && (ip === undefined || r.rdata === ip));
  for (const row of hits) await client.deleteRow(zone, row.id);
  if (hits.length > 0) await client.commit(zone);
  return hits.length;
}
