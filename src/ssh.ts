import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CaddyshipError, sq, sudoPrefix } from './util.js';
import { isSshTarget } from './validate.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a POSIX shell script somewhere (a remote server over SSH, or locally in tests). */
export interface Runner {
  readonly label: string;
  exec(script: string): Promise<ExecResult>;
}

function run(
  cmd: string,
  args: string[],
  script: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new CaddyshipError(`Command timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new CaddyshipError(
              `'${cmd}' was not found in PATH.`,
              cmd === 'ssh' ? 'Install an OpenSSH client (Windows: Settings > Optional features).' : undefined,
            )
          : e,
      );
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => undefined); // EPIPE if the process exits early
    child.stdin.end(script);
  });
}

export interface SshOptions {
  target: string;
  port?: number;
  identityFile?: string;
  timeoutMs?: number;
}

/**
 * Uses the system `ssh` binary, so ~/.ssh/config, ProxyJump, agents and
 * hardware keys all keep working. The script is sent on stdin to `sh -s`,
 * which avoids every quoting problem of passing it as an argument.
 */
export class SshRunner implements Runner {
  constructor(private readonly o: SshOptions) {
    if (!isSshTarget(o.target)) {
      throw new CaddyshipError(`Invalid SSH target '${o.target}'.`, 'Use host, user@host or a ~/.ssh/config alias.');
    }
  }

  get label(): string {
    return this.o.target;
  }

  buildArgs(): string[] {
    const a = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15'];
    if (this.o.port) a.push('-p', String(this.o.port));
    if (this.o.identityFile) a.push('-i', this.o.identityFile);
    const sockDir = path.join(homedir(), '.ssh');
    if (process.platform !== 'win32' && !process.env.CADDYSHIP_NO_MUX && existsSync(sockDir)) {
      a.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${sockDir}/caddyship-%C`);
    }
    a.push('--', this.o.target, 'sh -s');
    return a;
  }

  exec(script: string): Promise<ExecResult> {
    return run('ssh', this.buildArgs(), script, { timeoutMs: this.o.timeoutMs ?? 60_000 });
  }
}

/** Same interface, but local. Used by the test-suite. */
export class LocalRunner implements Runner {
  readonly label = 'local';
  constructor(private readonly o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {}
  exec(script: string): Promise<ExecResult> {
    return run('sh', ['-s'], script, {
      cwd: this.o.cwd,
      env: { ...process.env, ...this.o.env },
      timeoutMs: 30_000,
    });
  }
}

/** Run a script and throw with its stderr if it fails. */
export async function sh(r: Runner, script: string, what: string): Promise<string> {
  const res = await r.exec(script);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    throw new CaddyshipError(`${what} failed${detail ? `: ${detail}` : ` (exit ${res.code})`}`, explainSshFailure(detail));
  }
  return res.stdout;
}

export function explainSshFailure(detail: string): string | undefined {
  if (/a password is required|no tty present|sudo: a terminal is required/i.test(detail)) {
    return 'The SSH user needs passwordless sudo (or connect as root). Example: add "<user> ALL=(ALL) NOPASSWD: ALL" via visudo.';
  }
  if (/Host key verification failed/i.test(detail)) {
    return 'Run `ssh <target>` once manually to accept the host key, then retry.';
  }
  if (/Permission denied \(publickey/i.test(detail)) {
    return 'SSH key auth failed. Load your key into ssh-agent or set the identity file in the profile.';
  }
  return undefined;
}

/** Write a file via base64 so no content ever touches shell quoting. */
export async function writeRemoteFile(r: Runner, file: string, content: string, useSudo: boolean): Promise<void> {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  await sh(
    r,
    `printf %s ${sq(b64)} | base64 -d | ${sudoPrefix(useSudo)}tee ${sq(file)} >/dev/null`,
    `Writing ${file}`,
  );
}
