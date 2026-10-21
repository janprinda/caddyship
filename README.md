# caddyship

Publish Docker apps behind [Caddy](https://caddyserver.com) from your terminal, over SSH.
Optionally creates the DNS record at [WEDOS](https://www.wedos.com) in the same step.

```
$ caddyship add
◇ Nickname              ropa-deck
◇ Which domain?         china26.fun            (or "Enter my own domain...")
◇ Subdomain             ropa
◇ Point it at           This server (203.0.113.7)
◇ Docker host port      ropa-deck  8741 -> 8741
◇ Apply this?           Yes
✔ DNS record created
✔ Applying the Caddy config (validate, then reload)
Live: https://ropa.china26.fun
```

## Why

Editing a production Caddyfile by hand over SSH is easy to get wrong, and DNS lives in a
different browser tab. `caddyship` does both, and cannot leave a broken config behind:
every change is validated by Caddy first and rolled back automatically if validation or
the reload fails.

## Install

```sh
npm install -g caddyship      # or: npx caddyship
```

Requires Node 20+ and an OpenSSH client on your machine. On the server you need Caddy
and either root or a user with passwordless `sudo`.

## Quick start

```sh
caddyship init      # SSH target, Caddy detection, port range, WEDOS credentials
caddyship doctor    # verifies everything, including security hints
caddyship add       # interactive: nickname -> domain -> subdomain -> IP -> port
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Create or update a server profile. Detects systemd vs. Docker Caddy, adds one `import` line to your Caddyfile (with backup). |
| `add` | Interactive flow, or fully scripted with flags (see below). |
| `list` | Sites managed by caddyship (`--json` for scripts). |
| `remove <nickname>` | Removes the Caddy block; optionally deletes the DNS record it created. |
| `ports` | Used/free ports, next free port. `--range 8100-8999` and `--reserve 8080,8081` save settings. |
| `doctor` | Checks SSH, sudo, Caddy config, Docker, public IP and WEDOS access. |

### `add` flow

1. **Nickname**: a label so you remember which project owns which domain.
2. **Domain**: pick one of your WEDOS domains, or enter your own (no WEDOS call is made for your own).
3. **Subdomain** (WEDOS domains only).
4. **IP address**: this server, or another one. Pointing at another machine creates the DNS
   record only, because Caddy here could not get a certificate for it.
5. **Docker port**: choose a running container (its published port is filled in), take the
   next free port in your configured range, or type one.

### Scripted use

```sh
caddyship add --nickname ropa-deck --wedos-domain china26.fun --sub ropa --ip this --port 8741 --yes
caddyship add --nickname blog --custom-domain blog.example.com --port 8200 --yes
caddyship add ... --dry-run          # print the plan and the Caddy block, change nothing
caddyship remove ropa-deck --yes --delete-dns
```

## How it works

- Each site is one file in a directory caddyship owns (default `/etc/caddy/sites/<nickname>.caddy`).
  Your Caddyfile gets a single line, `import /etc/caddy/sites/*.caddy`, and is otherwise untouched.
- Every change: write file -> `caddy validate` -> reload. If validation or reload fails, the
  previous state is restored. Removed sites are kept under `sites/.removed/`.
- Site metadata (nickname, port, DNS record) lives in a header comment inside each file, so
  state travels with the server and works from any machine.
- Everything user-typed that reaches the Caddyfile is validated against strict patterns.
- DNS is created first and checked on public resolvers (up to 90 s, `--no-dns-wait` to skip),
  so Caddy's certificate challenge can succeed when it reloads.

## WEDOS DNS

Enable WAPI in the WEDOS customer panel, set a **WAPI password** (separate from your account
password) and add the public IP of the computer you run `caddyship` from to the **allow-list**.

- Only the SHA-1 of the WAPI password is stored (the API never needs the plain password).
  The config file `~/.config/caddyship/config.json` is created with mode `0600`.
- Existing records are never overwritten silently: a differing A/AAAA record stops the run
  unless you confirm or pass `--update-dns`; an existing CNAME is refused.
- Apex records (no subdomain) are not supported yet.

## Security notes

`doctor` warns when containers publish ports on all interfaces (Docker's default for
`ports: ["8741:8741"]`). Those ports stay reachable directly, bypassing Caddy, TLS and any
auth you add there. Bind them to loopback instead: `ports: ["127.0.0.1:8741:8741"]`.

## Docker-hosted Caddy (experimental)

`init` offers Docker mode when it finds a Caddy container. The sites directory must be
mounted into the container, and `reverse_proxy` must be able to reach published host ports
(default upstream host in this mode: `host.docker.internal`, which needs
`extra_hosts: ["host.docker.internal:host-gateway"]`).

## Status

0.1.0. The WEDOS client follows the official WAPI documentation and community clients and is
covered by tests against a mock server; run `caddyship doctor` once against your real account.
Planned: `edit`, adopting existing Caddyfile blocks, apex records, running WAPI calls from the
server so only its IP needs allow-listing.

## Development

```sh
npm install
npm test          # unit tests + apply/rollback tests against a fake server
npm run build     # bundles to dist/cli.js
```

`CADDYSHIP_CONFIG` overrides the config path; `CADDYSHIP_WAPI_ENDPOINT` points the WEDOS
client at a mock server; `CADDYSHIP_NO_MUX=1` disables SSH connection sharing.

## License

MIT
