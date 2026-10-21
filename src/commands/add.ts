import { applySite } from '../apply.js';
import { renderSite, type SiteSpec } from '../caddy.js';
import { gatherState, loadCtx } from '../context.js';
import { detectPublicIp, resolveAddresses, waitForDns } from '../net.js';
import { freePorts } from '../ports.js';
import { CaddyshipError } from '../util.js';
import { ask, isInteractive, p, task } from '../ui.js';
import { ipKind, isDomain, isNickname, isPort, isSubdomain, isUpstreamHost } from '../validate.js';
import { DnsConflictError, ensureAddressRecord, type DnsOutcome } from '../wedos.js';

export interface AddOptions {
  profile?: string;
  nickname?: string;
  wedosDomain?: string;
  customDomain?: string;
  sub?: string;
  /** `this` or an IP address (WEDOS flow only). */
  ip?: string;
  port?: string;
  upstreamHost?: string;
  encode: boolean;
  dnsWait: boolean;
  updateDns?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

const CUSTOM = '__custom__';

export async function add(o: AddOptions): Promise<void> {
  p.intro('caddyship - add a site');
  const ctx = await loadCtx(o.profile);
  const { profile, runner, wapi } = ctx;
  const tty = isInteractive();

  // Reject bad flags before touching the network.
  if (o.port !== undefined && !isPort(Number(o.port))) throw new CaddyshipError(`Invalid port '${o.port}'.`);
  if (o.upstreamHost !== undefined && !isUpstreamHost(o.upstreamHost)) {
    throw new CaddyshipError(`Invalid upstream host '${o.upstreamHost}'.`);
  }
  if (o.customDomain !== undefined && !isDomain(o.customDomain.toLowerCase())) {
    throw new CaddyshipError(`Invalid domain '${o.customDomain}'.`);
  }
  if (o.ip !== undefined && o.ip !== 'this' && !ipKind(o.ip)) {
    throw new CaddyshipError(`Invalid --ip '${o.ip}'.`, 'Use "this" or an IPv4/IPv6 address.');
  }

  const need = async <T>(value: T | undefined, flag: string, prompt: () => Promise<T>): Promise<T> => {
    if (value !== undefined) return value;
    if (!tty) throw new CaddyshipError(`Missing ${flag} (and there is no interactive terminal to ask).`);
    return prompt();
  };

  const state = await task(`Reading the state of ${runner.label}`, () => gatherState(ctx));
  const taken = new Set(state.sites.flatMap((s) => (s.meta ? [s.meta.nickname] : [])));

  // 1. nickname
  const nickname = await need(o.nickname, '--nickname', () =>
    ask(
      p.text({
        message: 'Nickname (so you can tell which project this is)',
        placeholder: 'ropa-deck',
        validate: (v) =>
          !isNickname(v ?? '')
            ? 'Lowercase letters, digits, - and _ (max 48)'
            : taken.has(v!)
              ? 'That nickname is already used'
              : undefined,
      }),
    ),
  );
  if (!isNickname(nickname)) throw new CaddyshipError(`Invalid nickname '${nickname}'.`);
  if (taken.has(nickname)) throw new CaddyshipError(`Nickname '${nickname}' is already used.`, 'See `caddyship list`.');

  // 2. which domain?
  let mode: 'wedos' | 'custom';
  if (o.customDomain) mode = 'custom';
  else if (o.wedosDomain || o.sub) mode = 'wedos';
  else if (!wapi) mode = 'custom';
  else mode = 'wedos'; // refined below once the zone list is known
  if (mode === 'wedos' && !wapi) {
    throw new CaddyshipError('WEDOS is not configured for this profile.', 'Run `caddyship init` and enter your WAPI credentials, or use --custom-domain.');
  }

  let zone: string | undefined;
  let sub: string | undefined;
  let domain: string;

  if (mode === 'wedos' && wapi) {
    const zones = await task('Loading your WEDOS domains', () => wapi.listDomains(), (z) => `${z.length} WEDOS domain(s) found`);
    if (o.wedosDomain) {
      if (!zones.includes(o.wedosDomain.toLowerCase())) {
        throw new CaddyshipError(`'${o.wedosDomain}' is not one of your WEDOS domains.`, `Available: ${zones.join(', ')}`);
      }
      zone = o.wedosDomain.toLowerCase();
    } else {
      const picked = await need(undefined as string | undefined, '--wedos-domain or --custom-domain', () =>
        ask(
          p.select({
            message: 'Which domain are you editing?',
            options: [
              ...zones.map((z) => ({ value: z, label: z })),
              { value: CUSTOM, label: 'Enter my own domain...', hint: 'skips WEDOS DNS' },
            ],
          }),
        ),
      );
      if (picked === CUSTOM) mode = 'custom';
      else zone = picked;
    }
  }

  if (mode === 'wedos' && zone) {
    const z = zone;
    sub = (
      await need(o.sub?.toLowerCase(), '--sub', () =>
        ask(
          p.text({
            message: `Subdomain on ${z}`,
            placeholder: 'app',
            validate: (v) => (isSubdomain((v ?? '').toLowerCase()) ? undefined : 'Letters, digits and - (use dots for deeper levels)'),
          }),
        ),
      )
    ).toLowerCase();
    if (!isSubdomain(sub)) throw new CaddyshipError(`Invalid subdomain '${sub}'.`);
    domain = `${sub}.${zone}`;
  } else {
    domain = (
      await need(o.customDomain?.toLowerCase(), '--custom-domain', () =>
        ask(
          p.text({
            message: 'Domain to serve',
            placeholder: 'app.example.com',
            validate: (v) => (isDomain((v ?? '').toLowerCase()) ? undefined : 'Expected a hostname such as app.example.com'),
          }),
        ),
      )
    ).toLowerCase();
    if (!isDomain(domain)) throw new CaddyshipError(`Invalid domain '${domain}'.`);
  }

  const clash = state.sites.find((s) => s.meta?.domain === domain);
  if (clash?.meta) {
    throw new CaddyshipError(`${domain} is already served by site '${clash.meta.nickname}'.`);
  }

  // 3. IP (WEDOS flow): this server or another one?
  let ip: string | undefined;
  let dnsOnly = false;
  let serverIp = profile.publicIp;
  if (mode === 'wedos') {
    serverIp ??= await task('Detecting the server public IP', () => detectPublicIp(runner), (v) => v ?? 'Could not detect it');
    const choice =
      o.ip === undefined
        ? await need(undefined as 'this' | 'other' | undefined, '--ip', () =>
            ask(
              p.select({
                message: 'Point the subdomain at which IP address?',
                options: [
                  { value: 'this' as const, label: `This server${serverIp ? ` (${serverIp})` : ''}` },
                  { value: 'other' as const, label: 'Another IP address...' },
                ],
              }),
            ),
          )
        : o.ip === 'this'
          ? 'this'
          : 'other';

    if (choice === 'this') {
      if (!serverIp) {
        throw new CaddyshipError('Could not detect the server public IP.', 'Pass --ip <address>, or set it with `caddyship init`.');
      }
      ip = serverIp;
    } else {
      ip = await need(o.ip && o.ip !== 'this' ? o.ip : undefined, '--ip', () =>
        ask(p.text({ message: 'IP address', placeholder: '203.0.113.7', validate: (v) => (ipKind(v ?? '') ? undefined : 'Not a valid IPv4/IPv6 address') })),
      );
      if (!ipKind(ip)) throw new CaddyshipError(`'${ip}' is not a valid IP address.`);
    }

    if (ip !== serverIp) {
      p.log.warn(
        `${ip} is not this server${serverIp ? ` (${serverIp})` : ''}. Caddy here cannot obtain a certificate for ${domain} unless DNS points to this server.`,
      );
      const what =
        tty && !o.yes
          ? await ask(
              p.select({
                message: 'What should I do?',
                options: [
                  { value: 'dns', label: 'Only create the DNS record', hint: 'no Caddy block on this server' },
                  { value: 'both', label: 'Create the DNS record and the Caddy block anyway' },
                  { value: 'stop', label: 'Cancel' },
                ],
              }),
            )
          : 'dns';
      if (what === 'stop') {
        p.cancel('Cancelled.');
        return;
      }
      dnsOnly = what === 'dns';
    }
  } else {
    // custom domain: just tell the user whether DNS already points here
    const addrs = await resolveAddresses(domain);
    serverIp ??= await task('Detecting the server public IP', () => detectPublicIp(runner), (v) => v ?? 'Could not detect it');
    if (addrs.length === 0) p.log.warn(`${domain} does not resolve yet. Create the DNS record at your DNS provider${serverIp ? ` (A -> ${serverIp})` : ''}.`);
    else if (serverIp && !addrs.includes(serverIp)) p.log.warn(`${domain} currently resolves to ${addrs.join(', ')}, not to this server (${serverIp}). Certificates will fail until it does.`);
  }

  // 4. port
  let port = 0;
  let exposedBinding = false;
  if (!dnsOnly) {
    const range = profile.ports;
    const [suggested] = freePorts(range, state.usage, 1);
    const fromFlag = o.port !== undefined ? Number(o.port) : undefined;
    if (fromFlag !== undefined && !isPort(fromFlag)) throw new CaddyshipError(`Invalid port '${o.port}'.`);

    port = await need(fromFlag, '--port', async () => {
      const seen = new Set<number>();
      const options: { value: number; label: string; hint?: string }[] = [];
      for (const c of state.docker.containers) {
        for (const pub of c.published) {
          if (seen.has(pub.hostPort)) continue;
          seen.add(pub.hostPort);
          options.push({ value: pub.hostPort, label: `${c.name}  ${pub.hostPort} -> ${pub.containerPort}`, hint: `${c.image} - ${c.status}` });
        }
      }
      options.push({ value: -1, label: `Next free port in ${range.min}-${range.max}`, hint: suggested ? String(suggested) : 'range is full' });
      options.push({ value: 0, label: 'Enter a port manually...' });
      const picked = await ask(p.select({ message: 'Docker host port to proxy to', options }));
      if (picked === -1) {
        if (!suggested) throw new CaddyshipError(`No free port left in ${range.min}-${range.max}.`);
        p.log.info(`Publish your container on it with:  ports: ["127.0.0.1:${suggested}:<container-port>"]`);
        return suggested;
      }
      if (picked === 0) {
        return Number(
          await ask(p.text({ message: 'Port', placeholder: String(suggested ?? 8000), validate: (v) => (isPort(Number(v)) ? undefined : '1-65535') })),
        );
      }
      return picked;
    });
    if (!isPort(port)) throw new CaddyshipError(`Invalid port '${port}'.`);

    if (port < range.min || port > range.max) p.log.warn(`Port ${port} is outside your configured range ${range.min}-${range.max}.`);
    const users = state.usage.used.get(port);
    if (!users) p.log.warn(`Nothing listens on port ${port} yet. Fine if you start the container afterwards.`);
    else if (users.startsWith("site '")) p.log.warn(`Port ${port} is already proxied by ${users}.`);
    exposedBinding = state.docker.containers.some((c) =>
      c.published.some((pub) => pub.hostPort === port && (pub.hostIp === '0.0.0.0' || pub.hostIp === '[::]')),
    );
  }

  const upstreamHost = o.upstreamHost ?? profile.caddy.upstreamHost;
  if (!isUpstreamHost(upstreamHost)) throw new CaddyshipError(`Invalid upstream host '${upstreamHost}'.`);

  const ttl = profile.wedos?.ttl ?? 300;
  const recordType: 'A' | 'AAAA' = ip && ipKind(ip) === 6 ? 'AAAA' : 'A';
  const spec: SiteSpec = {
    nickname,
    domain,
    port,
    upstreamHost,
    encode: o.encode,
    dns: mode === 'wedos' && ip ? `${recordType}:${ip}` : undefined,
    created: new Date().toISOString(),
  };

  // 5. plan + confirm
  const plan = [
    `Server    ${runner.label}`,
    `Nickname  ${nickname}`,
    `Domain    https://${domain}`,
    mode === 'wedos' && zone && sub ? `DNS       ${recordType} ${sub}.${zone} -> ${ip} (TTL ${ttl}) via WEDOS` : 'DNS       unchanged (point it yourself)',
    dnsOnly ? 'Caddy     not touched' : `Caddy     reverse_proxy ${upstreamHost}:${port}`,
  ];
  p.note(plan.join('\n'), 'Plan');
  if (!dnsOnly) p.log.message(renderSite(spec).trimEnd());

  if (o.dryRun) {
    p.outro('Dry run - nothing was changed.');
    return;
  }
  if (!o.yes) {
    if (!tty) throw new CaddyshipError('Refusing to change the server without confirmation.', 'Pass --yes in non-interactive mode.');
    if (!(await ask(p.confirm({ message: 'Apply this?', initialValue: true })))) {
      p.cancel('Cancelled.');
      return;
    }
  }

  // 6. DNS first, so the certificate challenge can succeed once Caddy reloads
  let outcome: DnsOutcome | undefined;
  if (mode === 'wedos' && wapi && zone && sub && ip) {
    const z = zone;
    const s = sub;
    const ipv = ip;
    const make = (onConflict: 'abort' | 'update') => ensureAddressRecord(wapi, z, s, recordType, ipv, ttl, onConflict);
    try {
      outcome = await task('Creating the DNS record at WEDOS', () => make(o.updateDns ? 'update' : 'abort'), (r) => `DNS record ${r}`);
    } catch (e) {
      if (e instanceof DnsConflictError && tty && !o.yes) {
        p.log.warn(e.message);
        if (!(await ask(p.confirm({ message: `Update it to ${ip}?`, initialValue: false })))) {
          p.cancel('Cancelled. Nothing was changed.');
          return;
        }
        outcome = await task('Updating the DNS record at WEDOS', () => make('update'), () => 'DNS record updated');
      } else {
        throw e;
      }
    }

    if (!dnsOnly && o.dnsWait && ip) {
      const seen = await task('Waiting for DNS to propagate (up to 90 s)', () => waitForDns(domain, ip!), (ok) =>
        ok ? 'DNS resolves to the new address' : 'DNS is not visible yet',
      );
      if (!seen) {
        p.log.warn('Continuing anyway - Caddy retries certificate issuance on its own once the record is live.');
      }
    }
  }

  if (dnsOnly) {
    p.outro(`DNS record ${outcome ?? 'handled'}. ${domain} -> ${ip}. No Caddy block was written here.`);
    return;
  }

  // 7. Caddy
  try {
    await task('Applying the Caddy config (validate, then reload)', () => applySite(runner, profile, spec));
  } catch (e) {
    if (outcome) p.log.warn(`The DNS record was already ${outcome} and stays in place. Re-run \`caddyship add\` after fixing the problem below.`);
    throw e;
  }

  if (exposedBinding) {
    p.log.info(`Port ${port} is published on all interfaces, so it is also reachable directly. Bind it to 127.0.0.1 (ports: ["127.0.0.1:${port}:..."]) to force traffic through Caddy.`);
  }
  p.outro(`Live: https://${domain}  (nickname: ${nickname})`);
}
