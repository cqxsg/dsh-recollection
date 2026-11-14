import { cpus, release, totalmem } from 'node:os';

export function environment() {
  return { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, memoryBytes: totalmem(), dsh: '0.2.1-rc.4', rg: '15.2.0' };
}
