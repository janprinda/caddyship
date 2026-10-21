import { removeSite } from '../apply.js';
import { gatherState, loadCtx } from '../context.js';
import { CaddyshipError } from '../util.js';
import { ask, isInteractive, p, task } from '../ui.js';
import { splitFqdn } from '../validate.js';
import { removeAddressRecord } from '../wedos.js';

export interface RemoveOptions {
  profile?: string;
  yes?: boolean;
  deleteDns?: boolean;
  keepDns?: boolean;
}

export async function remove(nickname: string, o: RemoveOptions): Promise<void> {
  p.intro(`caddyship - remove '${nickname}'`);
  const ctx = await loadCtx(o.profile);
  const { runner, profile, wapi } = ctx;
  const tty = isInteractive();

  const state = await task(`Reading ${runner.label}`, () => gatherState(ctx));
  const site = state.sites.find((s) => s.meta?.nickname === nickname);
  if (!site?.meta) {
    throw new CaddyshipError(`No managed site called '${nickname}'.`, 'See `caddyship list`.');
  }
  const meta = site.meta;

  if (!o.yes) {
    if (!tty) throw new CaddyshipError('Refusing to remove without confirmation.', 'Pass --yes in non-interactive mode.');
    const ok = await ask(p.confirm({ message: `Remove ${meta.domain} (port ${meta.port}) from Caddy?`, initialValue: false }));
    if (!ok) {
      p.cancel('Nothing changed.');
      return;
    }
  }

  await task('Removing the Caddy block (validate, then reload)', () => removeSite(runner, profile, nickname));

  // DNS: only offered when caddyship created the record in the first place
  const [type, ip] = (meta.dns ?? '').split(/:(.*)/s);
  if (!meta.dns || !type || !ip || !wapi) {
    p.outro(`Removed '${nickname}'. ${meta.dns ? 'WEDOS is not configured, so the DNS record was left alone.' : 'No DNS record was created by caddyship, so none was touched.'}`);
    return;
  }

  let wantDns = o.deleteDns === true;
  if (!o.deleteDns && !o.keepDns && tty && !o.yes) {
    wantDns = await ask(p.confirm({ message: `Also delete the ${type} record ${meta.domain} -> ${ip} at WEDOS?`, initialValue: false }));
  }
  if (!wantDns) {
    p.outro(`Removed '${nickname}'. The DNS record ${meta.domain} -> ${ip} was kept.`);
    return;
  }

  const zones = await task('Loading your WEDOS domains', () => wapi.listDomains());
  const parts = splitFqdn(meta.domain, zones);
  if (!parts) {
    p.outro(`Removed '${nickname}'. ${meta.domain} is not in your WEDOS account, so its DNS was left alone.`);
    return;
  }
  const n = await task('Deleting the DNS record', () => removeAddressRecord(wapi, parts.zone, parts.sub, type, ip), (c) => `${c} DNS record(s) deleted`);
  p.outro(n === 0 ? `Removed '${nickname}'. No matching DNS record was found.` : `Removed '${nickname}' and its DNS record.`);
}
