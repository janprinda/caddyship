import { listSites, type SiteEntry } from './caddy.js';
import { loadConfig, pickProfile } from './config.js';
import { listContainers, type DockerInfo } from './docker.js';
import { collectUsage, listListeningPorts, type PortUsage } from './ports.js';
import { SshRunner, type Runner } from './ssh.js';
import type { Config, Profile } from './types.js';
import { WapiClient } from './wedos.js';

export interface Ctx {
  cfg: Config;
  profile: Profile;
  runner: Runner;
  wapi?: WapiClient;
}

export async function loadCtx(profileName?: string): Promise<Ctx> {
  const cfg = await loadConfig();
  const profile = pickProfile(cfg, profileName);
  const runner = new SshRunner({
    target: profile.ssh.target,
    port: profile.ssh.port,
    identityFile: profile.ssh.identityFile,
  });
  const wapi = profile.wedos
    ? new WapiClient({ login: profile.wedos.login, passwordSha1: profile.wedos.passwordSha1 })
    : undefined;
  return { cfg, profile, runner, wapi };
}

export interface ServerState {
  sites: SiteEntry[];
  docker: DockerInfo;
  listening: number[];
  usage: PortUsage;
}

/** Everything the commands need to know about the server's current ports and sites. */
export async function gatherState(ctx: Ctx): Promise<ServerState> {
  const { runner, profile } = ctx;
  const [sites, docker, listening] = await Promise.all([
    listSites(runner, profile),
    listContainers(runner, profile.caddy.useSudo),
    listListeningPorts(runner),
  ]);
  const usage = collectUsage({
    listening,
    containers: docker.containers,
    sites,
    reserved: profile.ports.reserved,
  });
  return { sites, docker, listening, usage };
}
