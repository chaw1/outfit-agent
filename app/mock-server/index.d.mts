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

/** The first local edit per project reports edit_check.passed=false; later edits pass. */
export function createMockServer(options?: MockServerOptions): Promise<Server>;
