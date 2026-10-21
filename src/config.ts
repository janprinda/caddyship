import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Config, Profile } from './types.js';
import { CaddyshipError } from './util.js';

export function configPath(): string {
  if (process.env.CADDYSHIP_CONFIG) return process.env.CADDYSHIP_CONFIG;
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'));
  return path.join(base, 'caddyship', 'config.json');
}

export async function loadConfig(file: string = configPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
    throw e;
  }
  let parsed: Config;
  try {
    parsed = JSON.parse(raw) as Config;
  } catch {
    throw new CaddyshipError(`Config file is not valid JSON: ${file}`);
  }
  if (parsed?.version !== 1 || typeof parsed.profiles !== 'object' || parsed.profiles === null) {
    throw new CaddyshipError(`Unsupported config format in ${file}`);
  }
  return parsed;
}

export async function saveConfig(cfg: Config, file: string = configPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies on creation; tighten existing files too.
  await chmod(file, 0o600).catch(() => undefined);
}

export function pickProfile(cfg: Config, name?: string): Profile {
  const names = Object.keys(cfg.profiles);
  if (names.length === 0) {
    throw new CaddyshipError('No server profile configured yet.', 'Run `caddyship init` first.');
  }
  const wanted = name ?? cfg.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
  if (!wanted) {
    throw new CaddyshipError(
      'Several profiles exist and no default is set.',
      `Pass --profile <name>. Available: ${names.join(', ')}`,
    );
  }
  const profile = cfg.profiles[wanted];
  if (!profile) {
    throw new CaddyshipError(`Unknown profile '${wanted}'.`, `Available: ${names.join(', ')}`);
  }
  return profile;
}
