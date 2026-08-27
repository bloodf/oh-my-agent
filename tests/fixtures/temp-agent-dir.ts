/**
 * Purpose: Isolated temp directory with agents/ subdirectory for harness tests.
 * Public API: withTempAgentDir<T>(callback: (root: string) => Promise<T>): Promise<T>
 * Upstream deps: node:fs/promises, node:os, node:path
 * Downstream consumers: harness.test.ts
 * Failure modes: Cleanup via finally ensures dir removed even on callback throw.
 * Performance: mkdtemp is O(1); rm is async recursive.
 */
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

export async function withTempAgentDir<T>(
  callback: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agent-"));
  await mkdir(join(root, "agents"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
