import { Command } from 'commander';
import { add } from './commands/add.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { list } from './commands/list.js';
import { ports } from './commands/ports.js';
import { remove } from './commands/remove.js';
import { ApplyError } from './apply.js';
import { p } from './ui.js';
import { VERSION } from './version.js';

function report(e: unknown): never {
  const err = e as Error & { hint?: string; output?: string };
  p.log.error(err.message || String(e));
  if (e instanceof ApplyError && e.output) p.log.message(e.output.slice(0, 2000));
  if (err.hint) p.log.info(err.hint);
  if (process.env.CADDYSHIP_DEBUG && err.stack) console.error(err.stack);
  process.exit(1);
}

const wrap =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      report(e);
    }
  };

const program = new Command();
program
  .name('caddyship')
  .description('Publish Docker apps behind Caddy over SSH, with optional WEDOS DNS automation.')
  .version(VERSION)
  .showHelpAfterError();

program
  .command('init')
  .description('Set up a server profile (SSH, Caddy, port range, WEDOS credentials)')
  .option('--profile <name>', 'profile name to create or update')
  .action(wrap(init));

program
  .command('add')
  .description('Publish a Docker port on a (sub)domain: DNS record + Caddy block')
  .option('-p, --profile <name>', 'server profile to use')
  .option('--nickname <name>', 'label for this site, e.g. ropa-deck')
  .option('--wedos-domain <domain>', 'one of your WEDOS domains (creates the DNS record)')
  .option('--sub <label>', 'subdomain on the WEDOS domain, e.g. app or api.dev')
  .option('--custom-domain <domain>', 'any domain; skips WEDOS entirely')
  .option('--ip <this|address>', 'where the DNS record points (WEDOS flow); "this" = the server')
  .option('--port <number>', 'Docker host port to proxy to')
  .option('--upstream-host <host>', 'override the upstream host from the profile')
  .option('--no-encode', 'do not add `encode zstd gzip`')
  .option('--no-dns-wait', 'do not wait for DNS propagation before reloading Caddy')
  .option('--update-dns', 'overwrite an existing A/AAAA record that points elsewhere')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', 'show the plan and the Caddy block, change nothing')
  .action(wrap(add));

program
  .command('list')
  .alias('ls')
  .description('Show the sites managed by caddyship on the server')
  .option('-p, --profile <name>', 'server profile to use')
  .option('--json', 'machine-readable output')
  .action(wrap(list));

program
  .command('remove <nickname>')
  .alias('rm')
  .description('Remove a site (and optionally its DNS record)')
  .option('-p, --profile <name>', 'server profile to use')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--delete-dns', 'also delete the DNS record caddyship created')
  .option('--keep-dns', 'never delete the DNS record')
  .action(wrap(remove));

program
  .command('ports')
  .description('Show used and free ports; set the allowed range and reserved ports')
  .option('-p, --profile <name>', 'server profile to use')
  .option('--range <min-max>', 'save a new port range, e.g. 8100-8999')
  .option('--reserve <list>', 'save the reserved ports (comma-separated; empty string clears)')
  .option('--count <n>', 'how many free ports to list (default 5)')
  .action(wrap(ports));

program
  .command('doctor')
  .description('Check SSH, sudo, Caddy, Docker exposure and WEDOS access')
  .option('-p, --profile <name>', 'server profile to use')
  .action(wrap(doctor));

await program.parseAsync(process.argv);
