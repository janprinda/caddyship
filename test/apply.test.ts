import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySite, removeSite, ApplyError } from '../src/apply.js';
import { ensureImport, listSites, type SiteSpec } from '../src/caddy.js';
import { LocalRunner } from '../src/ssh.js';
import type { Profile } from '../src/types.js';

/**
 * End-to-end test of the apply/rollback logic against a fake "server":
 * a temp dir plus stub `caddy-validate` / `caddy-reload` scripts that fail
 * on demand (a file containing INVALID fails validation; a RELOAD_FAIL
 * marker file fails the reload).
 */
let root: string;
let profile: Profile;
const runner = () => new LocalRunner();

const spec = (over: Partial<SiteSpec> = {}): SiteSpec => ({
  nickname: 'app',
  domain: 'app.example.com',
  port: 8123,
  upstreamHost: '127.0.0.1',
  encode: true,
  created: '2026-10-21T21:41:00.000Z',
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'caddyship-'));
  const sites = path.join(root, 'sites');
  mkdirSync(sites);
  const caddyfile = path.join(root, 'Caddyfile');
  writeFileSync(caddyfile, 'existing.example.com {\n\trespond "ok"\n}\n');

  const validate = path.join(root, 'validate.sh');
  writeFileSync(
    validate,
    `#!/bin/sh\nif grep -rqs INVALID "${sites}" "${caddyfile}"; then echo "adapter error: INVALID directive" >&2; exit 1; fi\nexit 0\n`,
  );
  const reload = path.join(root, 'reload.sh');
  writeFileSync(reload, `#!/bin/sh\nif [ -e "${root}/RELOAD_FAIL" ]; then echo "reload boom" >&2; exit 1; fi\necho reloaded >> "${root}/reload.log"\n`);
  chmodSync(validate, 0o755);
  chmodSync(reload, 0o755);

  profile = {
    name: 't',
    ssh: { target: 'localhost' },
    caddy: {
      caddyfile,
      sitesDir: sites,
      useSudo: false,
      validateCommand: validate,
      reloadCommand: reload,
      upstreamHost: '127.0.0.1',
    },
    ports: { min: 8000, max: 8999, reserved: [] },
  };
});

const siteFile = () => path.join(profile.caddy.sitesDir, 'app.caddy');

describe('ensureImport', () => {
  it('adds the import line once and keeps a backup', async () => {
    expect(await ensureImport(runner(), profile)).toBe('added');
    const text = readFileSync(profile.caddy.caddyfile, 'utf8');
    expect(text).toContain(`import ${profile.caddy.sitesDir}/*.caddy`);
    expect(readdirSync(root).some((f) => f.startsWith('Caddyfile.caddyship-bak-'))).toBe(true);
    expect(await ensureImport(runner(), profile)).toBe('present');
    expect(text.match(/import /g)).toHaveLength(1);
  });

  it('restores the Caddyfile if Caddy rejects it', async () => {
    writeFileSync(profile.caddy.caddyfile, 'INVALID\n');
    const before = readFileSync(profile.caddy.caddyfile, 'utf8');
    await expect(ensureImport(runner(), profile)).rejects.toThrow(/original was restored/);
    expect(readFileSync(profile.caddy.caddyfile, 'utf8')).toBe(before);
  });

  it('fails clearly when the Caddyfile is missing', async () => {
    profile.caddy.caddyfile = path.join(root, 'nope');
    await expect(ensureImport(runner(), profile)).rejects.toThrow(/Cannot read/);
  });
});

describe('applySite', () => {
  it('writes, validates, reloads and lists the site', async () => {
    await applySite(runner(), profile, spec());
    expect(readFileSync(siteFile(), 'utf8')).toContain('reverse_proxy 127.0.0.1:8123');
    expect(readFileSync(path.join(root, 'reload.log'), 'utf8')).toBe('reloaded\n');
    const sites = await listSites(runner(), profile);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.meta).toMatchObject({ nickname: 'app', domain: 'app.example.com', port: 8123 });
  });

  it('refuses to clobber an existing nickname without overwrite', async () => {
    await applySite(runner(), profile, spec());
    await expect(applySite(runner(), profile, spec({ port: 9999 }))).rejects.toThrow(/already exists/);
    expect(readFileSync(siteFile(), 'utf8')).toContain(':8123');
  });

  it('rolls back a brand-new site when validation fails', async () => {
    // domain with INVALID in it makes the stub validator fail
    await expect(applySite(runner(), profile, spec({ domain: 'INVALID.example.com' }))).rejects.toBeInstanceOf(ApplyError);
    expect(existsSync(siteFile())).toBe(false);
    expect(existsSync(path.join(root, 'reload.log'))).toBe(false); // never reloaded
  });

  it('restores the previous version when an overwrite fails validation', async () => {
    await applySite(runner(), profile, spec());
    const good = readFileSync(siteFile(), 'utf8');
    await expect(
      applySite(runner(), profile, spec({ domain: 'INVALID.example.com' }), { overwrite: true }),
    ).rejects.toThrow(/Nothing was changed/);
    expect(readFileSync(siteFile(), 'utf8')).toBe(good);
    expect(existsSync(path.join(profile.caddy.sitesDir, '.app.caddy.bak'))).toBe(false);
  });

  it('rolls back and re-reloads when the reload itself fails', async () => {
    writeFileSync(path.join(root, 'RELOAD_FAIL'), '');
    await expect(applySite(runner(), profile, spec())).rejects.toThrow(/previous config was restored/);
    expect(existsSync(siteFile())).toBe(false);
  });
});

describe('removeSite', () => {
  it('moves the file to .removed and reloads', async () => {
    await applySite(runner(), profile, spec());
    await removeSite(runner(), profile, 'app');
    expect(existsSync(siteFile())).toBe(false);
    const kept = readdirSync(path.join(profile.caddy.sitesDir, '.removed'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^app\.\d+\.caddy$/);
  });

  it('errors for an unknown nickname', async () => {
    await expect(removeSite(runner(), profile, 'ghost')).rejects.toThrow(/No site called/);
  });

  it('restores the site if the reload fails', async () => {
    await applySite(runner(), profile, spec());
    writeFileSync(path.join(root, 'RELOAD_FAIL'), '');
    await expect(removeSite(runner(), profile, 'app')).rejects.toThrow(/site was restored/);
    expect(existsSync(siteFile())).toBe(true);
  });
});
