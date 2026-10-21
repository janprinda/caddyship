import { describe, expect, it } from 'vitest';
import { PROBE, parseProbe } from '../src/commands/init.js';
import { LocalRunner } from '../src/ssh.js';

describe('server probe used by `init`', () => {
  it('runs cleanly under plain sh and yields the keys init relies on', async () => {
    const res = await new LocalRunner().exec(PROBE);
    expect(res.code).toBe(0);
    const kv = parseProbe(res.stdout);
    for (const key of ['user', 'uid', 'sudo', 'systemd', 'bin', 'exec', 'dockercaddy']) {
      expect(kv).toHaveProperty(key);
    }
    expect(kv.sudo).toMatch(/^(yes|no)$/);
    expect(kv.uid).toMatch(/^\d+$/);
  });

  it('parses key=value lines and tolerates values containing "="', () => {
    expect(parseProbe('a=1\nexec=ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile\n\nbad line')).toEqual({
      a: '1',
      exec: 'ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile',
    });
  });
});
