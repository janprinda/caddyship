import { loadCtx } from '../context.js';
import { exposedPorts, listContainers } from '../docker.js';
import { detectPublicIp } from '../net.js';
import { explainSshFailure } from '../ssh.js';
import { sq, sudoPrefix } from '../util.js';
import { p } from '../ui.js';

type Level = 'ok' | 'warn' | 'fail';

export async function doctor(o: { profile?: string }): Promise<void> {
  p.intro('caddyship - doctor');
  const ctx = await loadCtx(o.profile);
  const { profile, runner, wapi } = ctx;
  const S = sudoPrefix(profile.caddy.useSudo);
  let failures = 0;

  const report = (level: Level, text: string, hint?: string): void => {
    if (level === 'ok') p.log.success(text);
    else if (level === 'warn') p.log.warn(text);
    else {
      failures++;
      p.log.error(text);
    }
    if (hint && level !== 'ok') p.log.message(`   ${hint}`);
  };

  // SSH
  const ping = await runner.exec('echo ok').catch((e: Error) => ({ code: 255, stdout: '', stderr: e.message }));
  if (ping.code !== 0 || ping.stdout.trim() !== 'ok') {
    const detail = (ping.stderr || ping.stdout).trim();
    report('fail', `SSH to ${runner.label} failed: ${detail}`, explainSshFailure(detail));
    p.outro('Fix SSH first, the other checks need it.');
    process.exitCode = 1;
    return;
  }
  report('ok', `SSH to ${runner.label} works`);

  if (profile.caddy.useSudo) {
    const sudo = await runner.exec('sudo -n true');
    sudo.code === 0
      ? report('ok', 'Passwordless sudo works')
      : report('fail', 'sudo needs a password', 'Allow passwordless sudo for this user (visudo) or connect as root.');
  }

  // Caddy
  const readable = await runner.exec(`[ -r ${sq(profile.caddy.caddyfile)} ]`);
  readable.code === 0
    ? report('ok', `Caddyfile found at ${profile.caddy.caddyfile}`)
    : report('fail', `Cannot read ${profile.caddy.caddyfile}`, 'Fix the path with `caddyship init`.');

  const imp = await runner.exec(`grep -qF ${sq(`import ${profile.caddy.sitesDir}/*.caddy`)} ${sq(profile.caddy.caddyfile)}`);
  imp.code === 0
    ? report('ok', `Caddyfile imports ${profile.caddy.sitesDir}`)
    : report('fail', 'The Caddyfile does not import the caddyship sites directory', 'Run `caddyship init` again and accept the import line.');

  const dir = await runner.exec(`${S}test -d ${sq(profile.caddy.sitesDir)} && ${S}test -w ${sq(profile.caddy.sitesDir)}`);
  dir.code === 0
    ? report('ok', `${profile.caddy.sitesDir} exists and is writable`)
    : report('fail', `${profile.caddy.sitesDir} is missing or not writable`);

  const validate = await runner.exec(profile.caddy.validateCommand);
  validate.code === 0
    ? report('ok', 'Caddy accepts the current configuration')
    : report('fail', 'Caddy rejects the current configuration', (validate.stderr || validate.stdout).trim().slice(0, 600));

  // Docker + exposure
  const docker = await listContainers(runner, profile.caddy.useSudo);
  if (!docker.available) {
    report('warn', 'Docker is not reachable for this user (port suggestions will rely on listening sockets only)', docker.error?.slice(0, 200));
  } else {
    report('ok', `Docker reachable, ${docker.containers.length} container(s)`);
    const exposed = exposedPorts(docker.containers);
    if (exposed.length > 0) {
      report(
        'warn',
        `${exposed.length} container(s) publish ports on all interfaces, so they are reachable without Caddy`,
        exposed.map((e) => `${e.name}: ${e.ports.join(', ')}`).join('\n   ') +
          '\n   Bind to loopback in compose ("127.0.0.1:PORT:PORT") or block them in the firewall - databases especially.',
      );
    } else {
      report('ok', 'No container publishes ports on all interfaces');
    }
  }

  // Public IP
  const ip = await detectPublicIp(runner);
  if (!ip) report('warn', 'Could not detect the server public IP (curl missing or no outbound access?)');
  else if (profile.publicIp && profile.publicIp !== ip) {
    report('warn', `Server public IP is ${ip} but the profile says ${profile.publicIp}`, 'Update it with `caddyship init` if the server moved.');
  } else report('ok', `Server public IP ${ip}`);

  // WEDOS
  if (!wapi) {
    p.log.info('WEDOS is not configured (custom domains only). Run `caddyship init` to add it.');
  } else {
    try {
      const domains = await wapi.listDomains();
      report('ok', `WEDOS WAPI works, ${domains.length} domain(s): ${domains.slice(0, 6).join(', ')}`);
    } catch (e) {
      report('fail', (e as Error).message, (e as { hint?: string }).hint);
    }
  }

  p.outro(failures === 0 ? 'All good.' : `${failures} problem(s) found.`);
  if (failures > 0) process.exitCode = 1;
}
