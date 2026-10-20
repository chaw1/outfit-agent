import type { Server } from 'node:http';

export interface MockServerOptions {
  dataDir?: string;
  fixturesDir?: string;
  clock?: () => number;
  publicBase?: string;
  previewDelayMs?: number;
  previewStaggerMs?: number;
  imageDelayMs?: number;
  imageStaggerMs?: number;
  editDelayMs?: number;
  videoDelayMs?: number;
  runningDelayMs?: number;
  tokenDelayMs?: number;
}

export function createMockServer(options?: MockServerOptions): Promise<Server>;
