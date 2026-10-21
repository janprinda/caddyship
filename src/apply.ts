import { renderSite, siteFilePath, type SiteSpec } from './caddy.js';
import type { Profile } from './types.js';
import { CaddyshipError, sq, sudoPrefix } from './util.js';
import { sh, writeRemoteFile, type Runner } from './ssh.js';

export class ApplyError extends CaddyshipError {
  constructor(
    message: string,
    public output: string,
    hint?: string,
  ) {
    super(message, hint);
    this.name = 'ApplyError';
  }
}

const bakPath = (p: Profile, nickname: string): string => `${p.caddy.sitesDir}/.${nickname}.caddy.bak`;

async function exists(r: Runner, file: string): Promise<boolean> {
  return (await r.exec(`[ -e ${sq(file)} ]`)).code === 0;
}

/**
 * Write (or replace) one site file, validate, reload.
 * On any failure the previous state is restored, so a bad config never stays live.
 */
export async function applySite(
  r: Runner,
  p: Profile,
  spec: SiteSpec,
  opts: { overwrite?: boolean } = {},
): Promise<void> {
  const S = sudoPrefix(p.caddy.useSudo);
  const file = siteFilePath(p, spec.nickname);
  const bak = bakPath(p, spec.nickname);

  await sh(r, `${S}mkdir -p ${sq(p.caddy.sitesDir)}`, `Creating ${p.caddy.sitesDir}`);
  const had = await exists(r, file);
  if (had && !opts.overwrite) {
    throw new CaddyshipError(`A site called '${spec.nickname}' already exists on the server.`);
  }

  const rollback = async (): Promise<void> => {
    await r.exec(`${S}rm -f ${sq(file)}; if [ -e ${sq(bak)} ]; then ${S}mv -f ${sq(bak)} ${sq(file)}; fi`);
  };

  if (had) await sh(r, `${S}mv -f ${sq(file)} ${sq(bak)}`, 'Backing up the previous site file');
  try {
    await writeRemoteFile(r, file, renderSite(spec), p.caddy.useSudo);
  } catch (e) {
    await rollback();
    throw e;
  }

  const v = await r.exec(p.caddy.validateCommand);
  if (v.code !== 0) {
    await rollback();
    throw new ApplyError(
      'Caddy rejected the new config. Nothing was changed on the server.',
      (v.stderr || v.stdout).trim(),
      'Common cause: the domain is already defined in another site block of your Caddyfile.',
    );
  }

  const rl = await r.exec(p.caddy.reloadCommand);
  if (rl.code !== 0) {
    await rollback();
    await r.exec(p.caddy.reloadCommand); // best effort: get Caddy back to the old config
    throw new ApplyError('Caddy reload failed. The previous config was restored.', (rl.stderr || rl.stdout).trim());
  }

  await r.exec(`${S}rm -f ${sq(bak)}`);
}

/** Remove a site file (kept under .removed/), validate, reload. */
export async function removeSite(r: Runner, p: Profile, nickname: string): Promise<void> {
  const S = sudoPrefix(p.caddy.useSudo);
  const file = siteFilePath(p, nickname);
  const bak = bakPath(p, nickname);

  if (!(await exists(r, file))) {
    throw new CaddyshipError(`No site called '${nickname}' on the server.`, 'See `caddyship list`.');
  }
  await sh(r, `${S}mv -f ${sq(file)} ${sq(bak)}`, 'Moving the site file aside');

  const restore = async (): Promise<void> => {
    await r.exec(`${S}mv -f ${sq(bak)} ${sq(file)}`);
  };

  const v = await r.exec(p.caddy.validateCommand);
  if (v.code !== 0) {
    await restore();
    throw new ApplyError('Caddy rejected the config after removal. Nothing was changed.', (v.stderr || v.stdout).trim());
  }
  const rl = await r.exec(p.caddy.reloadCommand);
  if (rl.code !== 0) {
    await restore();
    await r.exec(p.caddy.reloadCommand);
    throw new ApplyError('Caddy reload failed. The site was restored.', (rl.stderr || rl.stdout).trim());
  }

  const removed = `${p.caddy.sitesDir}/.removed`;
  await r.exec(
    `${S}mkdir -p ${sq(removed)} && ${S}mv -f ${sq(bak)} ${sq(`${removed}/${nickname}.${Date.now()}.caddy`)}`,
  );
}
