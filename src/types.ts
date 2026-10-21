export interface PortSettings {
  min: number;
  max: number;
  /** Ports that must never be suggested (e.g. 8080 used by something outside Docker). */
  reserved: number[];
}

export interface WedosSettings {
  login: string;
  /**
   * SHA-1 of the WAPI password. WAPI auth only ever needs sha1(password),
   * so the plain-text password is never stored.
   */
  passwordSha1: string;
  ttl: number;
}

export interface CaddySettings {
  caddyfile: string;
  /** Directory owned by caddyship; imported from the Caddyfile via `import <dir>/*.caddy`. */
  sitesDir: string;
  useSudo: boolean;
  validateCommand: string;
  reloadCommand: string;
  /** Host used in `reverse_proxy <host>:<port>`. */
  upstreamHost: string;
}

export interface Profile {
  name: string;
  ssh: { target: string; port?: number; identityFile?: string };
  caddy: CaddySettings;
  ports: PortSettings;
  /** Public IP of the server, used for "this server" DNS records. */
  publicIp?: string;
  wedos?: WedosSettings;
}

export interface Config {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}
