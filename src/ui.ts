import * as p from '@clack/prompts';

export { p };

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export function bail(message = 'Cancelled.'): never {
  p.cancel(message);
  process.exit(130);
}

/** Await a clack prompt and exit cleanly on Ctrl-C. */
export async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await prompt;
  if (p.isCancel(value)) bail();
  return value as Exclude<T, symbol>;
}

/** Run an async step behind a spinner. */
export async function task<T>(message: string, fn: () => Promise<T>, done?: (value: T) => string): Promise<T> {
  const s = p.spinner();
  s.start(message);
  try {
    const value = await fn();
    s.stop(done ? done(value) : message);
    return value;
  } catch (e) {
    s.error(`${message} - failed`);
    throw e;
  }
}
