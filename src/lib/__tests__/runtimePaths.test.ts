import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isServerlessReadOnlyEnv, resolveRuntimeDataDir } from "@/lib/runtimePaths";

describe("runtimePaths & Vercel serverless fallback", () => {
  it("prefers explicit ETG_DATA_DIR override when provided", () => {
    const resolved = resolveRuntimeDataDir({
      env: { ETG_DATA_DIR: "./custom-etg-data", VERCEL: "1" },
      cwd: "/var/task",
    });
    expect(resolved).toBe(path.resolve("./custom-etg-data"));
  });

  it("uses os.tmpdir()/etg-data automatically on Vercel / AWS Lambda environments", () => {
    expect(isServerlessReadOnlyEnv({ VERCEL: "1" })).toBe(true);
    expect(isServerlessReadOnlyEnv({ AWS_LAMBDA_FUNCTION_NAME: "handler" })).toBe(true);
    expect(isServerlessReadOnlyEnv({})).toBe(false);

    const vercelDir = resolveRuntimeDataDir({
      env: { VERCEL: "1" },
      cwd: process.cwd(),
    });
    const lambdaDir = resolveRuntimeDataDir({
      env: { AWS_LAMBDA_FUNCTION_NAME: "handler" },
      cwd: process.cwd(),
    });
    const expectedTmp = path.join(os.tmpdir(), "etg-data");
    expect(vercelDir).toBe(expectedTmp);
    expect(lambdaDir).toBe(expectedTmp);
  });

  it("falls back to os.tmpdir()/etg-data when cwd is read-only and uses .data when writable", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "etg-runtime-paths-"));
    const rwDir = path.join(tmpBase, "rw");
    const roDir = path.join(tmpBase, "ro");
    fs.mkdirSync(rwDir, { recursive: true });
    fs.mkdirSync(roDir, { recursive: true });

    try {
      expect(resolveRuntimeDataDir({ env: {}, cwd: rwDir })).toBe(path.join(rwDir, ".data"));

      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (!isRoot) {
        fs.chmodSync(roDir, 0o555);
        expect(resolveRuntimeDataDir({ env: {}, cwd: roDir })).toBe(
          path.join(os.tmpdir(), "etg-data")
        );
      }
    } finally {
      fs.chmodSync(roDir, 0o755);
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("ships bundled empirical denver-solar-seed-v4.json with globalGnn telemetry", () => {
    const seedPath = path.join(process.cwd(), "ml", "weights", "denver-solar-seed-v4.json");
    expect(fs.existsSync(seedPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(seedPath, "utf8")) as {
      metrics?: { graphAware?: { rmse?: number } };
      tomorrow?: { globalGnn?: { modelId?: string; p50?: number } };
      globalGnnBenchmark?: { denverAdapted?: { rmse?: number } };
    };
    expect(typeof parsed.metrics?.graphAware?.rmse).toBe("number");
    expect(parsed.metrics!.graphAware!.rmse!).toBeLessThan(1.0);
    expect(parsed.tomorrow?.globalGnn?.modelId).toBe("etg-global-gnn-v3");
    expect(typeof parsed.tomorrow?.globalGnn?.p50).toBe("number");
    expect(typeof parsed.globalGnnBenchmark?.denverAdapted?.rmse).toBe("number");
    expect(parsed.globalGnnBenchmark!.denverAdapted!.rmse!).toBeLessThan(1.0);
  });
});
