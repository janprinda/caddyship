import { sudoPrefix } from './util.js';
import type { Runner } from './ssh.js';

export interface Published {
  /** Bind address as printed by Docker: 0.0.0.0, [::], 127.0.0.1 ... */
  hostIp: string;
  hostPort: number;
  containerPort: number;
  proto: string;
}

export interface Container {
  name: string;
  image: string;
  status: string;
  published: Published[];
}

/** Parse the `Ports` column of `docker ps`, e.g. `0.0.0.0:8138->8080/tcp, [::]:8138->8080/tcp, 5432/tcp`. */
export function parsePorts(field: string): Published[] {
  const out: Published[] = [];
  for (const part of field.split(',').map((s) => s.trim())) {
    const m = /^(\[[^\]]+\]|[0-9.]+):(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/.exec(part);
    if (!m) continue; // internal-only (`5432/tcp`) or something unexpected
    const hostStart = Number(m[2]);
    const hostEnd = m[3] ? Number(m[3]) : hostStart;
    const contStart = Number(m[4]);
    for (let i = 0; i <= hostEnd - hostStart && i < 1000; i++) {
      out.push({ hostIp: m[1]!, hostPort: hostStart + i, containerPort: contStart + i, proto: m[6]! });
    }
  }
  return out;
}

export function parseContainers(output: string): Container[] {
  return output
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => {
      const [name = '', image = '', status = '', ports = ''] = l.split('|');
      return { name, image, status, published: parsePorts(ports) };
    });
}

export interface DockerInfo {
  available: boolean;
  containers: Container[];
  error?: string;
}

const FORMAT = `'{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'`;

export async function listContainers(r: Runner, useSudo: boolean): Promise<DockerInfo> {
  for (const prefix of ['', sudoPrefix(useSudo)]) {
    const res = await r.exec(`${prefix}docker ps -a --format ${FORMAT}`);
    if (res.code === 0) return { available: true, containers: parseContainers(res.stdout) };
    if (prefix === sudoPrefix(useSudo)) {
      return { available: false, containers: [], error: (res.stderr || res.stdout).trim() };
    }
  }
  return { available: false, containers: [] };
}

const isAllInterfaces = (ip: string): boolean => ip === '0.0.0.0' || ip === '[::]' || ip === '::';

/** Containers publishing ports on all interfaces, i.e. reachable without going through Caddy. */
export function exposedPorts(containers: Container[]): { name: string; ports: number[] }[] {
  return containers
    .map((c) => ({
      name: c.name,
      ports: [...new Set(c.published.filter((p) => isAllInterfaces(p.hostIp)).map((p) => p.hostPort))],
    }))
    .filter((c) => c.ports.length > 0);
}
