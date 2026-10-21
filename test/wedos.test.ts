import { describe, expect, it } from 'vitest';
import {
  WapiClient,
  WapiError,
  ensureAddressRecord,
  pragueHour,
  removeAddressRecord,
  sha1,
  wapiAuth,
} from '../src/wedos.js';

describe('WAPI auth', () => {
  it('uses the Europe/Prague hour, including DST', () => {
    // 2026-10-21 21:41Z -> Prague is still on summer time (UTC+2) -> 23
    expect(pragueHour(new Date('2026-10-21T21:41:00Z'))).toBe('23');
    // 2026-12-01 22:30Z -> winter time (UTC+1) -> 23
    expect(pragueHour(new Date('2026-12-01T22:30:00Z'))).toBe('23');
    // midnight must be "00", never "24"
    expect(pragueHour(new Date('2026-12-01T23:05:00Z'))).toBe('00');
    expect(pragueHour(new Date('2026-07-01T22:05:00Z'))).toBe('00');
  });

  it('hashes login + sha1(password) + hour', () => {
    const now = new Date('2026-12-01T09:00:00Z'); // 10 in Prague
    const expected = sha1(`me@example.com${sha1('secret')}10`);
    expect(wapiAuth('me@example.com', sha1('secret'), now)).toBe(expected);
  });
});

type Handler = (command: string, data: Record<string, unknown> | undefined) => { code: number; result?: string; data?: unknown };

function mockFetch(handler: Handler, seen: Array<{ command: string; auth: string; user: string; data?: unknown }> = []) {
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    const req = JSON.parse(body.get('request')!).request;
    seen.push({ command: req.command, auth: req.auth, user: req.user, data: req.data });
    const out = handler(req.command, req.data);
    return new Response(JSON.stringify({ response: { ...out, command: req.command } }), { status: 200 });
  }) as typeof fetch;
  return { impl, seen };
}

const client = (fetchImpl: typeof fetch, now?: () => Date) =>
  new WapiClient({ login: 'me@example.com', passwordSha1: sha1('secret'), fetchImpl, now });

describe('WapiClient', () => {
  it('sends form-encoded JSON with user, auth and command', async () => {
    const { impl, seen } = mockFetch(() => ({ code: 1000, data: { domain: [{ name: 'B.cz' }, { name: 'a.fun' }] } }));
    const domains = await client(impl, () => new Date('2026-12-01T09:00:00Z')).listDomains();
    expect(domains).toEqual(['a.fun', 'b.cz']);
    expect(seen[0]).toMatchObject({ command: 'dns-domains-list', user: 'me@example.com' });
    expect(seen[0]!.auth).toBe(wapiAuth('me@example.com', sha1('secret'), new Date('2026-12-01T09:00:00Z')));
  });

  it('copes with a single domain/row returned as an object instead of an array', async () => {
    const one = mockFetch((cmd) =>
      cmd === 'dns-domains-list'
        ? { code: 1000, data: { domain: { name: 'solo.cz' } } }
        : { code: 1000, data: { row: { ID: '7', name: 'app', rdtype: 'a', rdata: '1.2.3.4', ttl: '300' } } },
    );
    const c = client(one.impl);
    expect(await c.listDomains()).toEqual(['solo.cz']);
    expect(await c.listRows('solo.cz')).toEqual([{ id: '7', name: 'app', type: 'A', rdata: '1.2.3.4', ttl: 300 }]);
  });

  it('turns WAPI errors into WapiError with an allow-list hint for auth problems', async () => {
    const { impl } = mockFetch(() => ({ code: 2000, result: 'Authorization failed: IP not allowed' }));
    const err = await client(impl).listDomains().catch((e) => e);
    expect(err).toBeInstanceOf(WapiError);
    expect(err.code).toBe(2000);
    expect(err.hint).toMatch(/allow-list/);
  });

  it('retries once when the Prague hour rolls over mid-request', async () => {
    let calls = 0;
    const times = [new Date('2026-12-01T09:59:59Z'), new Date('2026-12-01T10:00:01Z'), new Date('2026-12-01T10:00:01Z'), new Date('2026-12-01T10:00:02Z')];
    let t = 0;
    const { impl } = mockFetch(() => {
      calls++;
      return calls === 1 ? { code: 2000, result: 'auth failed' } : { code: 1000, data: {} };
    });
    await client(impl, () => times[Math.min(t++, times.length - 1)]!).call('ping');
    expect(calls).toBe(2);
  });
});

describe('ensureAddressRecord', () => {
  const rows = (list: Array<Record<string, unknown>>) => ({ code: 1000, data: { row: list } });

  it('creates and commits when the record is missing', async () => {
    const { impl, seen } = mockFetch((cmd) => (cmd === 'dns-rows-list' ? rows([]) : { code: 1000, data: {} }));
    const out = await ensureAddressRecord(client(impl), 'china26.fun', 'app', 'A', '1.2.3.4', 300);
    expect(out).toBe('created');
    expect(seen.map((s) => s.command)).toEqual(['dns-rows-list', 'dns-row-add', 'dns-domain-commit']);
    expect(seen[1]!.data).toMatchObject({ domain: 'china26.fun', name: 'app', type: 'A', rdata: '1.2.3.4', ttl: 300 });
  });

  it('is a no-op when the record already matches', async () => {
    const { impl, seen } = mockFetch(() => rows([{ ID: '1', name: 'app', rdtype: 'A', rdata: '1.2.3.4', ttl: 300 }]));
    expect(await ensureAddressRecord(client(impl), 'china26.fun', 'app', 'A', '1.2.3.4', 300)).toBe('unchanged');
    expect(seen).toHaveLength(1);
  });

  it('refuses to overwrite a different value unless told to', async () => {
    const existing = rows([{ ID: '1', name: 'app', rdtype: 'A', rdata: '9.9.9.9', ttl: 300 }]);
    const a = mockFetch(() => existing);
    await expect(ensureAddressRecord(client(a.impl), 'china26.fun', 'app', 'A', '1.2.3.4', 300)).rejects.toThrow(/9\.9\.9\.9/);
    const b = mockFetch((cmd) => (cmd === 'dns-rows-list' ? existing : { code: 1000, data: {} }));
    expect(await ensureAddressRecord(client(b.impl), 'china26.fun', 'app', 'A', '1.2.3.4', 300, 'update')).toBe('updated');
    expect(b.seen.map((s) => s.command)).toEqual(['dns-rows-list', 'dns-row-update', 'dns-domain-commit']);
    expect(b.seen[1]!.data).toMatchObject({ row_id: '1', rdata: '1.2.3.4' });
  });

  it('refuses to add an A record next to a CNAME', async () => {
    const { impl } = mockFetch(() => rows([{ ID: '2', name: 'app', rdtype: 'CNAME', rdata: 'x.example.com', ttl: 300 }]));
    await expect(ensureAddressRecord(client(impl), 'china26.fun', 'app', 'A', '1.2.3.4', 300)).rejects.toThrow(/CNAME/);
  });
});

describe('removeAddressRecord', () => {
  it('deletes only matching rows and commits', async () => {
    const { impl, seen } = mockFetch((cmd) =>
      cmd === 'dns-rows-list'
        ? {
            code: 1000,
            data: {
              row: [
                { ID: '1', name: 'app', rdtype: 'A', rdata: '1.2.3.4', ttl: 300 },
                { ID: '2', name: 'app', rdtype: 'A', rdata: '5.6.7.8', ttl: 300 },
                { ID: '3', name: 'other', rdtype: 'A', rdata: '1.2.3.4', ttl: 300 },
              ],
            },
          }
        : { code: 1000, data: {} },
    );
    expect(await removeAddressRecord(client(impl), 'china26.fun', 'app', 'A', '1.2.3.4')).toBe(1);
    expect(seen.map((s) => s.command)).toEqual(['dns-rows-list', 'dns-row-delete', 'dns-domain-commit']);
    expect(seen[1]!.data).toMatchObject({ row_id: '1' });
  });
});
