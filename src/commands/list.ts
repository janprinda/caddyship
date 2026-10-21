import { gatherState, loadCtx } from '../context.js';
import { p, task } from '../ui.js';

export async function list(o: { profile?: string; json?: boolean }): Promise<void> {
  const ctx = await loadCtx(o.profile);
  const sites = o.json
    ? (await gatherState(ctx)).sites
    : (await task(`Reading ${ctx.runner.label}`, () => gatherState(ctx))).sites;

  if (o.json) {
    process.stdout.write(`${JSON.stringify(sites, null, 2)}\n`);
    return;
  }
  if (sites.length === 0) {
    p.log.info('No sites yet. Create one with `caddyship add`.');
    return;
  }

  const rows = sites.map((s) =>
    s.meta
      ? [s.meta.nickname, s.meta.domain, `${s.meta.upstream}:${s.meta.port}`, s.meta.dns ?? '-']
      : [s.file.split('/').pop() ?? s.file, '(not managed by caddyship)', '', ''],
  );
  const header = ['NICKNAME', 'DOMAIN', 'UPSTREAM', 'DNS'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  p.log.message([line(header), ...rows.map(line)].join('\n'));
}
