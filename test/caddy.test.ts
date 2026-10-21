import { describe, expect, it } from 'vitest';
import { parseSiteMeta, renderSite, upstreamAddress, type SiteSpec } from '../src/caddy.js';
import { isDomain, isNickname, isSshTarget, isSubdomain, parsePortList, parsePortRange, splitFqdn } from '../src/validate.js';
import { parseContainers, parsePorts, exposedPorts } from '../src/docker.js';
import { collectUsage, freePorts, nextFreePort, parseListening } from '../src/ports.js';

const spec: SiteSpec = {
  nickname: 'ropa-deck',
  domain: 'ropa.china26.fun',
  port: 8741,
  upstreamHost: '127.0.0.1',
  encode: true,
  dns: 'A:203.0.113.7',
  created: '2026-10-21T21:41:00.000Z',
};

describe('site files', () => {
  it('renders a valid-looking Caddy block with a parseable header', () => {
    const text = renderSite(spec);
    expect(text).toContain('ropa.china26.fun {');
    expect(text).toContain('\tencode zstd gzip');
    expect(text).toContain('\treverse_proxy 127.0.0.1:8741');
    expect(parseSiteMeta(text)).toEqual({
      nickname: 'ropa-deck',
      domain: 'ropa.china26.fun',
      port: 8741,
      upstream: '127.0.0.1',
      dns: 'A:203.0.113.7',
      created: '2026-10-21T21:41:00.000Z',
    });
  });

  it('omits encode when disabled and brackets IPv6 upstreams', () => {
    expect(renderSite({ ...spec, encode: false })).not.toContain('encode');
    expect(upstreamAddress('::1', 80)).toBe('[::1]:80');
  });

  it('ignores hand-written files', () => {
    expect(parseSiteMeta('example.com {\n\trespond "hi"\n}\n')).toBeUndefined();
  });
});

describe('validation (nothing user-typed may reach the Caddyfile unchecked)', () => {
  it('nicknames', () => {
    expect(isNickname('ropa-deck')).toBe(true);
    for (const bad of ['', 'Ropa', 'a b', 'a/b', '../x', '-x', 'a;rm', 'a\nb']) expect(isNickname(bad)).toBe(false);
  });
  it('domains', () => {
    expect(isDomain('china26.fun')).toBe(true);
    expect(isDomain('app.china26.fun')).toBe(true);
    for (const bad of ['localhost', 'a b.com', 'x.com {', 'x.com\nrespond', '-a.com', 'a..com', 'a.com/']) {
      expect(isDomain(bad)).toBe(false);
    }
  });
  it('subdomains', () => {
    expect(isSubdomain('app')).toBe(true);
    expect(isSubdomain('api.dev')).toBe(true);
    for (const bad of ['', '@', '*', 'a b', '.a', 'a.', 'a_b']) expect(isSubdomain(bad)).toBe(false);
  });
  it('ssh targets cannot look like options', () => {
    expect(isSshTarget('root@home.example.com')).toBe(true);
    expect(isSshTarget('homeserver')).toBe(true);
    for (const bad of ['-oProxyCommand=x', '', 'a b', 'a;b']) expect(isSshTarget(bad)).toBe(false);
  });
  it('port ranges and lists', () => {
    expect(parsePortRange('8100-8999')).toEqual({ min: 8100, max: 8999 });
    expect(() => parsePortRange('9000-8000')).toThrow();
    expect(() => parsePortRange('0-70000')).toThrow();
    expect(parsePortList('8081, 8080 8081')).toEqual([8080, 8081]);
    expect(() => parsePortList('80,abc')).toThrow();
  });
  it('splits an FQDN by the longest owned zone', () => {
    expect(splitFqdn('a.b.china26.fun', ['china26.fun', 'b.china26.fun'])).toEqual({ sub: 'a', zone: 'b.china26.fun' });
    expect(splitFqdn('x.other.cz', ['china26.fun'])).toBeUndefined();
  });
});

// Mirrors the container list the user pasted.
const PS = [
  'spinny-mcspinface|spinny-mcspinface|Up 2 days|0.0.0.0:8967->8967/tcp, [::]:8967->8967/tcp',
  'drive-api-1|drive-api|Up 2 days|0.0.0.0:8138->8080/tcp, [::]:8138->8080/tcp',
  'drive-db-1|postgres:16-alpine|Up 2 days|0.0.0.0:5432->5432/tcp',
  'drive-worker-1|drive-worker|Up 2 days|',
  'chalupa_postgres|postgres:15-alpine|Up 3 days|5432/tcp',
  'seaweedfs|chrislusf/seaweedfs|Up 3 days|0.0.0.0:8333->8333/tcp, 127.0.0.1:8888->8888/tcp',
  'rng|x|Up|0.0.0.0:9000-9002->9000-9002/tcp',
].join('\n');

describe('docker', () => {
  it('parses published ports, ignores internal-only ones and expands ranges', () => {
    expect(parsePorts('0.0.0.0:8138->8080/tcp, [::]:8138->8080/tcp, 5432/tcp')).toEqual([
      { hostIp: '0.0.0.0', hostPort: 8138, containerPort: 8080, proto: 'tcp' },
      { hostIp: '[::]', hostPort: 8138, containerPort: 8080, proto: 'tcp' },
    ]);
    expect(parsePorts('0.0.0.0:9000-9002->9000-9002/tcp').map((p) => p.hostPort)).toEqual([9000, 9001, 9002]);
  });

  it('flags containers published on all interfaces', () => {
    const exposed = exposedPorts(parseContainers(PS));
    expect(exposed.find((e) => e.name === 'drive-db-1')?.ports).toEqual([5432]);
    expect(exposed.find((e) => e.name === 'seaweedfs')?.ports).toEqual([8333]); // 8888 is loopback-only
    expect(exposed.find((e) => e.name === 'chalupa_postgres')).toBeUndefined();
  });
});

describe('ports', () => {
  it('parses ss and netstat output', () => {
    const ss = [
      'LISTEN 0 4096 0.0.0.0:8138 0.0.0.0:*',
      'LISTEN 0 4096 [::]:8138 [::]:*',
      'LISTEN 0 128 *:22 *:*',
    ].join('\n');
    expect(parseListening(ss).sort((a, b) => a - b)).toEqual([22, 8138]);
    const netstat = 'tcp 0 0 0.0.0.0:3306 0.0.0.0:* LISTEN\ntcp6 0 0 :::8080 :::* LISTEN';
    expect(parseListening(netstat).sort((a, b) => a - b)).toEqual([3306, 8080]);
  });

  it('suggests the lowest free port in range, honouring reserved and every source of usage', () => {
    const usage = collectUsage({
      listening: [8100, 8101],
      containers: parseContainers('a|x|Up|0.0.0.0:8102->80/tcp'),
      sites: [{ file: 'f', meta: { nickname: 'n', domain: 'd.cz', port: 8103, upstream: '127.0.0.1' } }],
      reserved: [8104],
    });
    const range = { min: 8100, max: 8110, reserved: [] };
    expect(nextFreePort(range, usage)).toBe(8105);
    expect(freePorts(range, usage, 3)).toEqual([8105, 8106, 8107]);
    expect(usage.used.get(8103)).toBe("site 'n'");
  });

  it('throws a helpful error when the range is exhausted', () => {
    const usage = collectUsage({ listening: [1, 2], containers: [], sites: [], reserved: [] });
    expect(() => nextFreePort({ min: 1, max: 2, reserved: [] }, usage)).toThrow(/No free port/);
  });
});
