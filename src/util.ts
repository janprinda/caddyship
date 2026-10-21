/** Quote a string for safe use inside a POSIX shell command. */
export const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Error with an optional human hint; the CLI prints both. */
export class CaddyshipError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'CaddyshipError';
  }
}

export const sudoPrefix = (useSudo: boolean): string => (useSudo ? 'sudo -n ' : '');
