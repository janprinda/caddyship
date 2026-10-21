import { isIP } from 'node:net';
import { CaddyshipError } from './util.js';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TLD = '[a-z][a-z0-9-]{1,62}';
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+${TLD}$`);
const SUBDOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** Nicknames end up in file names and the Caddyfile header, so keep them boring. */
export const isNickname = (s: string): boolean => /^[a-z0-9][a-z0-9_-]{0,47}$/.test(s);

export const isDomain = (s: string): boolean => s.length <= 253 && DOMAIN_RE.test(s);

/** A relative DNS name such as `app` or `api.dev` (apex records are not supported). */
export const isSubdomain = (s: string): boolean => s.length <= 190 && SUBDOMAIN_RE.test(s);

export const isPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/** 4, 6 or 0 (not an IP address). */
export const ipKind = (s: string): 4 | 6 | 0 => {
  const k = isIP(s);
  return k === 4 || k === 6 ? k : 0;
};

export const isUpstreamHost = (s: string): boolean =>
  ipKind(s) !== 0 || /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s);

/** ssh target: `host`, `user@host` or an alias; must not look like an option. */
export const isSshTarget = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(s);

export function parsePortRange(input: string): { min: number; max: number } {
  const m = /^\s*(\d{1,5})\s*[-–:]\s*(\d{1,5})\s*$/.exec(input);
  const min = Number(m?.[1]);
  const max = Number(m?.[2]);
  if (!m || !isPort(min) || !isPort(max) || min > max) {
    throw new CaddyshipError(`Invalid port range '${input}'`, 'Use the form 8100-8999 (min-max, 1-65535).');
  }
  return { min, max };
}

export function parsePortList(input: string): number[] {
  const parts = input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ports = parts.map(Number);
  if (ports.some((p) => !isPort(p))) {
    throw new CaddyshipError(`Invalid port list '${input}'`, 'Use comma-separated ports, e.g. 8080,8081.');
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function toFqdn(sub: string, zone: string): string {
  return `${sub}.${zone}`;
}

/** Split an FQDN into [label, zone] given the zones the account owns (longest zone wins). */
export function splitFqdn(fqdn: string, zones: string[]): { sub: string; zone: string } | undefined {
  const zone = [...zones]
    .sort((a, b) => b.length - a.length)
    .find((z) => fqdn.endsWith(`.${z}`));
  return zone ? { sub: fqdn.slice(0, -(zone.length + 1)), zone } : undefined;
}
