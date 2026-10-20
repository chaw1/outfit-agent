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
  /** Exercise App fallback against a missing /me route or a pre-profile user shape. */
  legacyProfile?: 'missing' | 'old-fields';
}

/** The first local edit per project reports edit_check.passed=false; later edits pass. */
export function createMockServer(options?: MockServerOptions): Promise<Server>;
