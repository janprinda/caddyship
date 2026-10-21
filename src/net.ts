import { Resolver } from 'node:dns/promises';
import { sleep } from './util.js';
import { ipKind } from './validate.js';
import type { Runner } from './ssh.js';

/** Ask the server for its public IPv4 address. */
export async function detectPublicIp(r: Runner): Promise<string | undefined> {
  const res = await r.exec(
    'curl -4fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -4fsS --max-time 6 https://ifconfig.me 2>/dev/null',
  );
  const ip = res.stdout.trim();
  return ipKind(ip) === 4 ? ip : undefined;
}

function resolver(): Resolver {
  const res = new Resolver({ timeout: 3000, tries: 2 });
  res.setServers(['1.1.1.1', '8.8.8.8']);
  return res;
}

/** Addresses a hostname currently resolves to (empty if none). */
export async function resolveAddresses(host: string): Promise<string[]> {
  const res = resolver();
  const [a, aaaa] = await Promise.all([res.resolve4(host).catch(() => []), res.resolve6(host).catch(() => [])]);
  return [...a, ...aaaa].map((s) => s.toLowerCase());
}

/** Poll public resolvers until `host` resolves to `expected` (or the timeout hits). */
export async function waitForDns(
  host: string,
  expected: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await resolveAddresses(host)).includes(expected.toLowerCase())) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}
