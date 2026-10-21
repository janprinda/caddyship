import path from 'node:path/posix';
import { ensureImport } from '../caddy.js';
import { loadConfig, saveConfig } from '../config.js';
import { SshRunner, explainSshFailure } from '../ssh.js';
import type { Profile, WedosSettings } from '../types.js';
import { CaddyshipError, sudoPrefix } from '../util.js';
import { ask, p, task } from '../ui.js';
import { detectPublicIp } from '../net.js';
import { ipKind, isPort, isNickname, isSshTarget, isUpstreamHost, parsePortList, parsePortRange } from '../validate.js';
import { WapiClient, sha1 } from '../wedos.js';

export const PROBE = `
echo "user=$(id -un)"
echo "uid=$(id -u)"
echo "sudo=$(sudo -n true >/dev/null 2>&1 && echo yes || echo no)"
echo "systemd=$(systemctl is-active caddy 2>/dev/null || true)"
echo "bin=$(command -v caddy 2>/dev/null || true)"
echo "exec=$(systemctl cat caddy 2>/dev/null | grep -m1 '^ExecStart=' || true)"
echo "dockercaddy=$( (docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null || sudo -n docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null) | grep -i caddy | tr '\\n' ';' )"
`;

export function parseProbe(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return kv;
}

const textOrUndefined = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

export async function init(opts: { profile?: string }): Promise<void> {
  p.intro('caddyship - set up a server profile');
  const cfg = await loadConfig();

  const name = await ask(
    p.text({
      message: 'Profile name',
      initialValue: opts.profile ?? 'home',
      validate: (v) => (isNickname(v ?? '') ? undefined : 'Lowercase letters, digits, - and _ only'),
    }),
  );
  if (cfg.profiles[name]) {
    const ok = await ask(p.confirm({ message: `Profile '${name}' already exists. Overwrite it?`, initialValue: false }));
    if (!ok) {
      p.cancel('Nothing changed.');
      return;
    }
  }

  const target = await ask(
    p.text({
      message: 'SSH target (user@host, or an alias from ~/.ssh/config)',
      placeholder: 'root@home.example.com',
      validate: (v) => (isSshTarget(v ?? '') ? undefined : 'Expected host, user@host or an ssh config alias'),
    }),
  );
  const portRaw = textOrUndefined(
    await ask(p.text({ message: 'SSH port', placeholder: 'leave empty for the default (22)', defaultValue: '' })),
  );
  if (portRaw && !isPort(Number(portRaw))) throw new CaddyshipError(`Invalid SSH port '${portRaw}'.`);
  const identityFile = textOrUndefined(
    await ask(
      p.text({
        message: 'SSH identity file',
        placeholder: 'leave empty to use ssh-agent / ~/.ssh/config',
        defaultValue: '',
      }),
    ),
  );

  const ssh = { target, port: portRaw ? Number(portRaw) : undefined, identityFile };
  const runner = new SshRunner(ssh);

  const probe = await task('Connecting and looking for Caddy', async () => {
    const res = await runner.exec(PROBE);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new CaddyshipError(`SSH connection failed: ${detail || `exit ${res.code}`}`, explainSshFailure(detail));
    }
    return parseProbe(res.stdout);
  });

  const isRoot = probe.uid === '0';
  const useSudo = !isRoot;
  if (useSudo && probe.sudo !== 'yes') {
    p.log.warn(`'${probe.user}' has no passwordless sudo. Writing to /etc/caddy will fail until you allow it (or connect as root).`);
  }

  // How does Caddy run on this server?
  const dockerCaddies = (probe.dockercaddy ?? '')
    .split(';')
    .filter(Boolean)
    .map((s) => {
      const [cname = '', image = ''] = s.split('|');
      return { cname, image };
    });
  const modeOptions: { value: string; label: string; hint?: string }[] = [];
  if (probe.systemd === 'active' || probe.bin) {
    modeOptions.push({
      value: 'systemd',
      label: 'systemd / host install',
      hint: probe.systemd === 'active' ? 'caddy.service is active' : `binary at ${probe.bin}`,
    });
  }
  for (const c of dockerCaddies) {
    modeOptions.push({ value: `docker:${c.cname}`, label: `Docker container ${c.cname}`, hint: `${c.image} (experimental)` });
  }
  modeOptions.push({ value: 'custom', label: 'Custom validate/reload commands' });
  if (modeOptions.length === 1) p.log.warn('No Caddy found on the server (not a systemd service, no Caddy container).');

  const mode = await ask(p.select({ message: 'Which Caddy serves your reverse proxies?', options: modeOptions }));

  const execCfg = /--config[ =]+(\S+)/.exec(probe.exec ?? '')?.[1];
  const caddyfile = await ask(
    p.text({ message: 'Caddyfile path on the server', initialValue: execCfg ?? '/etc/caddy/Caddyfile' }),
  );
  const sitesDir = await ask(
    p.text({
      message: 'Directory caddyship may own for per-site files',
      initialValue: path.join(path.dirname(caddyfile), 'sites'),
    }),
  );

  const S = sudoPrefix(useSudo);
  let validateCommand = `${S}caddy validate --config ${caddyfile} --adapter caddyfile`;
  let reloadCommand = `${S}systemctl reload caddy`;
  let upstreamHost = '127.0.0.1';
  if (mode.startsWith('docker:')) {
    const c = mode.slice('docker:'.length);
    validateCommand = `${S}docker exec ${c} caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`;
    reloadCommand = `${S}docker exec ${c} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`;
    upstreamHost = 'host.docker.internal';
    p.note(
      [
        `The sites directory must be mounted into the container (e.g. ${sitesDir}:${sitesDir}),`,
        `and the container needs: extra_hosts: ["host.docker.internal:host-gateway"]`,
        'so that reverse_proxy can reach ports published on the host.',
      ].join('\n'),
      'Docker mode',
    );
  }
  if (mode === 'custom' || mode.startsWith('docker:')) {
    validateCommand = await ask(p.text({ message: 'Validate command', initialValue: validateCommand }));
    reloadCommand = await ask(p.text({ message: 'Reload command', initialValue: reloadCommand }));
  }
  upstreamHost = await ask(
    p.text({
      message: 'Upstream host used in reverse_proxy (where Docker publishes ports, as seen from Caddy)',
      initialValue: upstreamHost,
      validate: (v) => (isUpstreamHost(v ?? '') ? undefined : 'Expected a hostname or IP'),
    }),
  );

  const rangeRaw = await ask(
    p.text({
      message: 'Port range caddyship may suggest for new apps',
      initialValue: '8000-8999',
      validate: (v) => {
        try {
          parsePortRange(v ?? '');
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    }),
  );
  const reservedRaw = await ask(
    p.text({
      message: 'Ports to never suggest (comma-separated, optional)',
      placeholder: '8080,8081',
      defaultValue: '',
      validate: (v) => {
        try {
          parsePortList(v ?? '');
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    }),
  );
  const range = parsePortRange(rangeRaw);

  const detected = await task('Detecting the server public IP', () => detectPublicIp(runner), (ip) =>
    ip ? `Server public IP: ${ip}` : 'Could not detect the public IP',
  );
  const publicIpRaw = textOrUndefined(
    await ask(
      p.text({
        message: 'Public IP used for "this server" DNS records',
        initialValue: detected ?? '',
        placeholder: 'e.g. 203.0.113.7',
        defaultValue: '',
        validate: (v) => (!v || ipKind(v) !== 0 ? undefined : 'Not a valid IP address'),
      }),
    ),
  );

  const profile: Profile = {
    name,
    ssh,
    caddy: { caddyfile, sitesDir, useSudo, validateCommand, reloadCommand, upstreamHost },
    ports: { ...range, reserved: parsePortList(reservedRaw) },
    publicIp: publicIpRaw,
    wedos: cfg.profiles[name]?.wedos,
  };

  const wantImport = await ask(
    p.confirm({
      message: `Add "import ${sitesDir}/*.caddy" to ${caddyfile}? (a timestamped backup is made and Caddy validates the result)`,
      initialValue: true,
    }),
  );
  if (wantImport) {
    const res = await task('Preparing the Caddyfile', () => ensureImport(runner, profile), (r) =>
      r === 'added' ? 'Import line added (backup kept next to the Caddyfile)' : 'Import line already present',
    );
    void res;
  }

  profile.wedos = await setupWedos(profile.wedos);

  cfg.profiles[name] = profile;
  cfg.defaultProfile ??= name;
  await saveConfig(cfg);
  p.outro(`Saved profile '${name}'. Next: caddyship doctor, then caddyship add`);
}

async function setupWedos(existing?: WedosSettings): Promise<WedosSettings | undefined> {
  const want = await ask(
    p.confirm({
      message: existing ? 'Re-enter WEDOS WAPI credentials?' : 'Set up WEDOS DNS (WAPI) so subdomains can be created automatically?',
      initialValue: !existing,
    }),
  );
  if (!want) return existing;

  p.note(
    [
      'WEDOS panel -> your account -> WAPI: enable it, set a WAPI password',
      '(separate from your account password) and add the public IP of THIS',
      'computer to the allow-list. WAPI rejects requests from any other IP.',
      '',
      'Only the SHA-1 of the WAPI password is stored, never the password itself.',
    ].join('\n'),
    'WEDOS WAPI',
  );

  for (;;) {
    const login = await ask(
      p.text({ message: 'WEDOS login (account e-mail)', initialValue: existing?.login, validate: (v) => (v?.includes('@') ? undefined : 'Expected an e-mail address') }),
    );
    const password = await ask(p.password({ message: 'WAPI password', validate: (v) => (v ? undefined : 'Required') }));
    const settings: WedosSettings = { login, passwordSha1: sha1(password), ttl: existing?.ttl ?? 300 };
    try {
      const domains = await task('Checking the credentials', () =>
        new WapiClient({ login, passwordSha1: settings.passwordSha1 }).listDomains(),
      );
      p.log.success(`WAPI works - ${domains.length} domain(s): ${domains.slice(0, 6).join(', ')}${domains.length > 6 ? ', ...' : ''}`);
      return settings;
    } catch (e) {
      p.log.error((e as Error).message);
      const hint = (e as CaddyshipError).hint;
      if (hint) p.log.info(hint);
      const next = await ask(
        p.select({
          message: 'What now?',
          options: [
            { value: 'retry', label: 'Try again' },
            { value: 'save', label: 'Save these credentials anyway', hint: 'e.g. IP not allow-listed yet' },
            { value: 'skip', label: 'Skip WEDOS for now' },
          ],
        }),
      );
      if (next === 'save') return settings;
      if (next === 'skip') return existing;
    }
  }
}
