import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as etgStoreModule from "@/lib/graph/etgStore";
import * as etgSeriesAndTrustUtils from "@/lib/graph/store/etgSeriesAndTrustUtils";
import * as trendMicroscope from "@/lib/graph/trendMicroscope";

const SRC_ROOT = path.resolve(process.cwd(), "src");

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function resolveModulePath(fromFile: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = path.join(SRC_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return path.normalize(cand);
    }
  }
  return null;
}

function getValueImportSpecifiers(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (!clause) {
        // Side-effect import (`import "foo"`)
        specifiers.push(stmt.moduleSpecifier.text);
        continue;
      }
      if (clause.isTypeOnly) continue;

      const hasDefaultValue = Boolean(clause.name);
      const named = clause.namedBindings;
      let hasNamedValue = false;
      if (named) {
        if (ts.isNamespaceImport(named)) {
          hasNamedValue = true;
        } else if (ts.isNamedImports(named)) {
          hasNamedValue = named.elements.some((el) => !el.isTypeOnly);
        }
      }
      if (hasDefaultValue || hasNamedValue) {
        specifiers.push(stmt.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      if (!stmt.exportClause) {
        specifiers.push(stmt.moduleSpecifier.text);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        const hasValueExport = stmt.exportClause.elements.some((el) => !el.isTypeOnly);
        if (hasValueExport) {
          specifiers.push(stmt.moduleSpecifier.text);
        }
      }
    }
  }

  return specifiers;
}

function hasUseClientDirective(filePath: string): boolean {
  const text = fs.readFileSync(filePath, "utf8");
  const trimmed = text.trimStart();
  return trimmed.startsWith('"use client"') || trimmed.startsWith("'use client'");
}

describe("Post-Modularization Boundary & Cycle Regressions", () => {
  it("has zero runtime circular value-import cycles across src/lib/graph and src/components", () => {
    const graphFiles = collectTsFiles(path.join(SRC_ROOT, "lib/graph"));
    const componentFiles = collectTsFiles(path.join(SRC_ROOT, "components"));
    const allFiles = [...graphFiles, ...componentFiles];

    const adj = new Map<string, string[]>();
    for (const file of allFiles) {
      const edges: string[] = [];
      for (const spec of getValueImportSpecifiers(file)) {
        const resolved = resolveModulePath(file, spec);
        if (resolved) edges.push(resolved);
      }
      adj.set(file, edges);
    }

    const state = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];
    const cycles: string[] = [];

    function dfs(node: string) {
      state.set(node, "visiting");
      stack.push(node);
      for (const next of adj.get(node) ?? []) {
        const nextState = state.get(next);
        if (nextState === "visiting") {
          const idx = stack.indexOf(next);
          const cycle = [...stack.slice(idx), next].map((p) => path.relative(SRC_ROOT, p));
          cycles.push(cycle.join(" -> "));
        } else if (!nextState && adj.has(next)) {
          dfs(next);
        }
      }
      stack.pop();
      state.set(node, "visited");
    }

    for (const file of allFiles) {
      if (!state.has(file)) dfs(file);
    }

    expect(cycles).toEqual([]);
  });

  it("keeps trendMicroscope and etgStore decoupled with identical re-exported helpers", () => {
    expect(typeof trendMicroscope.scanTrendMicroscope).toBe("function");
    expect(typeof trendMicroscope.scanTrendMicroscopeAsync).toBe("function");
    expect(etgStoreModule.alignCompatibleSeries).toBe(etgSeriesAndTrustUtils.alignCompatibleSeries);
    expect(etgStoreModule.computeEtgNodeTrustScore).toBe(
      etgSeriesAndTrustUtils.computeEtgNodeTrustScore
    );
    expect(etgStoreModule.inferNodeTemporalScale).toBe(
      etgSeriesAndTrustUtils.inferNodeTemporalScale
    );
    expect(etgStoreModule.isCommunityContributorNode).toBe(
      etgSeriesAndTrustUtils.isCommunityContributorNode
    );
  });

  it("never leaks node:* or server-only graph modules into any client component value import closure", () => {
    const componentFiles = collectTsFiles(path.join(SRC_ROOT, "components"));
    const clientEntries = componentFiles.filter(hasUseClientDirective);
    expect(clientEntries.length).toBeGreaterThan(0);

    const forbiddenServerBasenames = new Set([
      "etgPersistence.ts",
      "etgStore.ts",
      "trendMicroscope.ts",
      "graphPredictor.ts",
      "denverClimateGraph.ts",
    ]);

    const visited = new Set<string>();
    const violations: string[] = [];

    function walkClientClosure(filePath: string, chain: string[]) {
      if (visited.has(filePath)) return;
      visited.add(filePath);

      for (const spec of getValueImportSpecifiers(filePath)) {
        if (spec.startsWith("node:") || spec === "fs" || spec === "path" || spec === "crypto") {
          violations.push(`${path.relative(SRC_ROOT, filePath)} imports "${spec}" (via ${chain.join(" -> ")})`);
          continue;
        }
        const resolved = resolveModulePath(filePath, spec);
        if (!resolved) continue;
        if (forbiddenServerBasenames.has(path.basename(resolved))) {
          violations.push(
            `${path.relative(SRC_ROOT, filePath)} value-imports server module ${path.relative(SRC_ROOT, resolved)}`
          );
          continue;
        }
        walkClientClosure(resolved, [...chain, path.basename(resolved)]);
      }
    }

    for (const entry of clientEntries) {
      walkClientClosure(entry, [path.basename(entry)]);
    }

    expect(violations).toEqual([]);
  });

  it("preserves workspace hook client directives and UI modularization invariants", () => {
    const telemetryHook = path.join(SRC_ROOT, "components/workspace/useWorkspaceTelemetry.ts");
    const graphActionsHook = path.join(SRC_ROOT, "components/workspace/useWorkspaceGraphActions.ts");
    expect(hasUseClientDirective(telemetryHook)).toBe(true);
    expect(hasUseClientDirective(graphActionsHook)).toBe(true);

    const evidenceTab = fs.readFileSync(
      path.join(SRC_ROOT, "components/workbench/WorkbenchEvidenceTab.tsx"),
      "utf8"
    );
    expect(evidenceTab).toContain("lastNodeUuidRef");

    const predictTab = fs.readFileSync(
      path.join(SRC_ROOT, "components/workbench/WorkbenchPredictTab.tsx"),
      "utf8"
    );
    expect(predictTab).toContain("lastNodeUuidRef");
    expect(predictTab).toContain("AbortController");
    expect(predictTab).toContain("[selectedNode.uuid]");

    const globe = fs.readFileSync(path.join(SRC_ROOT, "components/EarthGlobe3D.tsx"), "utf8");
    expect(globe).toContain("const [containerWidth, setContainerWidth] = useState(600)");
    expect(globe).toContain("containerWidth={containerWidth}");
    expect(globe).not.toContain("containerWidth={containerRef.current?.clientWidth");

    const svgNodes = fs.readFileSync(
      path.join(SRC_ROOT, "components/graph/GraphCanvas2DSvgDefsAndNodes.tsx"),
      "utf8"
    );
    expect(svgNodes).toContain("data-node-uuid={node.uuid}");
  });
});
