import type { SiteEntry } from './caddy.js';
import type { Container } from './docker.js';
import type { PortSettings } from './types.js';
import { CaddyshipError } from './util.js';
import type { Runner } from './ssh.js';

/** Parse `ss -ltn[H]` or `netstat -ltn` output into listening port numbers. */
export function parseListening(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    const m = local ? /:(\d+)$/.exec(local) : null;
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

export async function listListeningPorts(r: Runner): Promise<number[]> {
  const res = await r.exec(
    '(ss -ltnH 2>/dev/null || ss -ltn 2>/dev/null | tail -n +2 || netstat -ltn 2>/dev/null | tail -n +3)',
  );
  return parseListening(res.stdout);
}

export interface PortUsage {
  /** port -> what is using it (first reason wins) */
  used: Map<number, string>;
}

export function collectUsage(opts: {
  listening: number[];
  containers: Container[];
  sites: SiteEntry[];
  reserved: number[];
}): PortUsage {
  const used = new Map<number, string>();
  const claim = (port: number, why: string): void => {
    if (!used.has(port)) used.set(port, why);
  };
  for (const s of opts.sites) if (s.meta) claim(s.meta.port, `site '${s.meta.nickname}'`);
  for (const c of opts.containers) for (const p of c.published) claim(p.hostPort, `container ${c.name}`);
  for (const port of opts.listening) claim(port, 'listening on the server');
  for (const port of opts.reserved) claim(port, 'reserved in profile');
  return { used };
}

/** Lowest free ports inside the configured range. */
export function freePorts(range: PortSettings, usage: PortUsage, count = 1): number[] {
  const out: number[] = [];
  for (let port = range.min; port <= range.max && out.length < count; port++) {
    if (!usage.used.has(port)) out.push(port);
  }
  return out;
}

export function nextFreePort(range: PortSettings, usage: PortUsage): number {
  const [port] = freePorts(range, usage, 1);
  if (port === undefined) {
    throw new CaddyshipError(
      `No free port left in ${range.min}-${range.max}.`,
      'Widen the range with `caddyship ports --range <min>-<max>`.',
    );
  }
  return port;
}
