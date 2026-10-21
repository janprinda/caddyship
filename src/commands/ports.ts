import { gatherState, loadCtx } from '../context.js';
import { saveConfig } from '../config.js';
import { freePorts } from '../ports.js';
import { CaddyshipError } from '../util.js';
import { p, task } from '../ui.js';
import { parsePortList, parsePortRange } from '../validate.js';

export interface PortsOptions {
  profile?: string;
  range?: string;
  reserve?: string;
  count?: string;
}

export async function ports(o: PortsOptions): Promise<void> {
  const ctx = await loadCtx(o.profile);
  const { profile, cfg } = ctx;

  if (o.range || o.reserve !== undefined) {
    if (o.range) {
      const { min, max } = parsePortRange(o.range);
      profile.ports.min = min;
      profile.ports.max = max;
    }
    if (o.reserve !== undefined) profile.ports.reserved = parsePortList(o.reserve);
    cfg.profiles[profile.name] = profile;
    await saveConfig(cfg);
    p.log.success(`Saved: range ${profile.ports.min}-${profile.ports.max}, reserved ${profile.ports.reserved.join(', ') || 'none'}`);
  }

  const count = o.count ? Number(o.count) : 5;
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new CaddyshipError('--count must be 1-100.');

  const state = await task(`Reading ${ctx.runner.label}`, () => gatherState(ctx));
  const { min, max } = profile.ports;
  const inRange = [...state.usage.used.entries()].filter(([port]) => port >= min && port <= max).sort((a, b) => a[0] - b[0]);
  const free = freePorts(profile.ports, state.usage, count);

  const lines = [
    `Range     ${min}-${max}  (${max - min + 1} ports, ${inRange.length} in use)`,
    `Reserved  ${profile.ports.reserved.join(', ') || 'none'}`,
    `Free      ${free.length ? free.join(', ') : 'none - widen the range'}`,
  ];
  p.note(lines.join('\n'), 'Ports');
  if (inRange.length > 0) {
    p.log.message(inRange.map(([port, why]) => `${String(port).padEnd(6)} ${why}`).join('\n'));
  }
}
