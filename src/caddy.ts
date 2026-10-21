import type { Profile } from './types.js';
import { CaddyshipError, sq, sudoPrefix } from './util.js';
import { ipKind } from './validate.js';
import { sh, type Runner } from './ssh.js';

export interface SiteSpec {
  nickname: string;
  domain: string;
  port: number;
  upstreamHost: string;
  encode: boolean;
  /** e.g. `A:203.0.113.7` when caddyship created the DNS record. */
  dns?: string;
  created: string;
}

export interface SiteMeta {
  nickname: string;
  domain: string;
  port: number;
  upstream: string;
  dns?: string;
  created?: string;
}

export interface SiteEntry {
  file: string;
  /** undefined for hand-written files in the sites dir. */
  meta?: SiteMeta;
}

const HEADER = /^# caddyship v1 (.+)$/m;

export const upstreamAddress = (host: string, port: number): string =>
  `${ipKind(host) === 6 ? `[${host}]` : host}:${port}`;

export function renderSite(s: SiteSpec): string {
  const meta = [
    'v1',
    `nickname=${s.nickname}`,
    `domain=${s.domain}`,
    `port=${s.port}`,
    `upstream=${s.upstreamHost}`,
    ...(s.dns ? [`dns=${s.dns}`] : []),
    `created=${s.created}`,
  ];
  const lines = [
    `# caddyship ${meta.join(' ')}`,
    '# Managed by caddyship. Manual edits may be overwritten by `caddyship` commands.',
    `${s.domain} {`,
  ];
  if (s.encode) lines.push('\tencode zstd gzip');
  lines.push(`\treverse_proxy ${upstreamAddress(s.upstreamHost, s.port)}`, '}', '');
  return lines.join('\n');
}

export function parseSiteMeta(text: string): SiteMeta | undefined {
  const m = HEADER.exec(text);
  if (!m?.[1]) return undefined;
  const kv: Record<string, string> = {};
  for (const part of m[1].split(' ')) {
    const i = part.indexOf('=');
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  const port = Number(kv.port);
  if (!kv.nickname || !kv.domain || !Number.isInteger(port)) return undefined;
  return {
    nickname: kv.nickname,
    domain: kv.domain,
    port,
    upstream: kv.upstream ?? '127.0.0.1',
    dns: kv.dns,
    created: kv.created,
  };
}

export const siteFilePath = (p: Profile, nickname: string): string => `${p.caddy.sitesDir}/${nickname}.caddy`;

/** Read every *.caddy file in the sites dir (header only). */
export async function listSites(r: Runner, p: Profile): Promise<SiteEntry[]> {
  const dir = p.caddy.sitesDir;
  const script =
    `for f in ${sq(dir)}/*.caddy; do [ -e "$f" ] || continue; ` +
    `printf '@@FILE %s\\n' "$f"; head -n 5 "$f"; done`;
  const out = await r.exec(script);
  if (out.code !== 0 && !/No such file/i.test(out.stderr)) {
    throw new CaddyshipError(`Could not list ${dir}: ${out.stderr.trim() || `exit ${out.code}`}`);
  }
  const entries: SiteEntry[] = [];
  for (const chunk of out.stdout.split('@@FILE ').slice(1)) {
    const nl = chunk.indexOf('\n');
    const file = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    entries.push({ file, meta: parseSiteMeta(chunk.slice(nl + 1)) });
  }
  return entries;
}

/**
 * Make sure the main Caddyfile imports the caddyship sites directory.
 * Backs the Caddyfile up first and restores it if Caddy rejects the result.
 */
export async function ensureImport(r: Runner, p: Profile): Promise<'present' | 'added'> {
  const { caddyfile, sitesDir, useSudo, validateCommand } = p.caddy;
  const S = sudoPrefix(useSudo);
  const line = `import ${sitesDir}/*.caddy`;

  await sh(r, `${S}mkdir -p ${sq(sitesDir)}`, `Creating ${sitesDir}`);

  const has = await r.exec(`grep -qF ${sq(line)} ${sq(caddyfile)}`);
  if (has.code === 0) return 'present';
  if (has.code !== 1) {
    throw new CaddyshipError(
      `Cannot read ${caddyfile}: ${has.stderr.trim() || `exit ${has.code}`}`,
      'Check the Caddyfile path in your profile (caddyship init).',
    );
  }

  const backup = `${caddyfile}.caddyship-bak-${Date.now()}`;
  await sh(r, `${S}cp -a ${sq(caddyfile)} ${sq(backup)}`, 'Backing up the Caddyfile');
  await sh(
    r,
    `printf '\\n# Added by caddyship: per-site configs live here\\n%s\\n' ${sq(line)} | ${S}tee -a ${sq(caddyfile)} >/dev/null`,
    'Adding the import line',
  );
  const v = await r.exec(validateCommand);
  if (v.code !== 0) {
    await r.exec(`${S}cp -a ${sq(backup)} ${sq(caddyfile)}`);
    throw new CaddyshipError(
      `Caddy rejected the Caddyfile after adding the import; the original was restored.\n${(v.stderr || v.stdout).trim()}`,
      'A Caddyfile without any braces (single-site shorthand) cannot hold more than one site. Wrap it in `example.com { ... }`.',
    );
  }
  return 'added';
}
