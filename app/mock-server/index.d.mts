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
  /** Minimum observable pause for each automatic shoot step. */
  autoStepDelayMs?: number;
  /** Autonomous worker tick; no frontend polling is required for automatic shoots. */
  workerIntervalMs?: number;
  /** Exercise App fallback against a missing /me route or a pre-profile user shape. */
  legacyProfile?: 'missing' | 'old-fields';
  /** Return 404 for the material library while keeping the existing profile API. */
  legacyAssets?: boolean;
}

/** The first local edit per project reports edit_check.passed=false; later edits pass. */
export function createMockServer(options?: MockServerOptions): Promise<Server>;
