import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Returns true when running inside a serverless runtime where `process.cwd()`
 * (e.g. `/var/task` on Vercel or AWS Lambda) is mounted read-only.
 */
export function isServerlessReadOnlyEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  return Boolean(
    env.VERCEL ||
      env.VERCEL_ENV ||
      env.AWS_LAMBDA_FUNCTION_NAME ||
      env.LAMBDA_TASK_ROOT
  );
}

/**
 * Resolves a writable runtime data directory for cached state and ledgers.
 * Prefers explicit `ETG_DATA_DIR`, uses `os.tmpdir()/etg-data` on read-only
 * serverless platforms (e.g. Vercel), and otherwise uses `<cwd>/.data` when writable.
 */
export function resolveRuntimeDataDir(options?: {
  env?: Record<string, string | undefined>;
  cwd?: string;
}): string {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();

  const customDir = env.ETG_DATA_DIR?.trim();
  if (customDir) {
    return path.resolve(customDir);
  }

  if (isServerlessReadOnlyEnv(env)) {
    return path.join(os.tmpdir(), "etg-data");
  }

  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    return path.join(cwd, ".data");
  } catch {
    return path.join(os.tmpdir(), "etg-data");
  }
}
