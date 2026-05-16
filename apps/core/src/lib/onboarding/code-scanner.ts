// Workers-compatible deep code scanner.
// Ports Railway's analysis pipeline (src/services/code-scanner.ts) but
// replaces the I/O layer: GitHub tree API + raw content URLs replace git
// clone + node:fs. micromatch replaces fast-glob (no process/fs needed).

import micromatch from "micromatch";
import { getAnthropic } from "./anthropic";
import type {
  TechStack,
  FileNode,
  KeyFile,
  ManifestInfo,
  ScanResult,
  ProductAnalysis,
} from "./types";

export type { TechStack, FileNode, KeyFile, ManifestInfo, ScanResult, ProductAnalysis };

// ─── Constants (verbatim from Railway) ─────────────────────────────────────

const MAX_FILE_CHARS = 3_000;
const MAX_KEY_FILES = 10;
const MAX_README_CHARS = 4_000;

const SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".dart_tool",
  ".gradle",
];

const MANIFEST_FILES: Array<{
  filename: string;
  type: ManifestInfo["type"];
}> = [
  { filename: "package.json", type: "package.json" },
  { filename: "Cargo.toml", type: "Cargo.toml" },
  { filename: "pyproject.toml", type: "pyproject.toml" },
  { filename: "go.mod", type: "go.mod" },
  { filename: "pubspec.yaml", type: "pubspec.yaml" },
];

const KEY_FILE_GLOBS = [
  // Documentation
  "README*",
  // Entry points
  "src/app/page.tsx",
  "src/index.ts",
  "src/main.ts",
  "src/main.tsx",
  "app.ts",
  "main.py",
  "src/lib.rs",
  "cmd/*/main.go",
  // API surface
  "src/app/api/**/route.ts",
  "src/routes/**/*.ts",
  "src/api/**/*.ts",
  // Schema / types
  "src/**/*schema*.ts",
  "src/**/*types*.ts",
  "src/models/**/*.ts",
  // Config
  ".env.example",
  // Components (first few)
  "src/components/**/*.tsx",
];

const CODEBASE_ANALYZE_PROMPT = `You analyze codebases to understand what product or service they build.
Given the repository contents below (README, manifest, source files), extract:

1. productName — the actual product/brand name
2. oneLiner — one sentence describing what it does, in plain language
3. targetAudience — who this product is for (be specific)
4. keywords — 5-8 topic keywords a potential user would search for (lowercase, no brand names)
5. valueProp — the core value proposition in one sentence

If the codebase is a library/tool, describe what it helps developers build.
If it's an app, describe what end users get from it.

Respond with ONLY a JSON object:
{"productName":"...","oneLiner":"...","targetAudience":"...","keywords":["..."],"valueProp":"..."}`;

// ─── GitHub API I/O ─────────────────────────────────────────────────────────

interface RepoTreeFile {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface RepoTreeResult {
  branch: string;
  files: string[];
}

/**
 * Fetch the full recursive file tree of a GitHub repo via the REST API.
 * Returns the default branch name and sorted list of file paths (blobs only,
 * SKIP_DIRS filtered out).
 */
export async function fetchRepoTree(
  token: string,
  repoFullName: string,
): Promise<RepoTreeResult> {
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "ShipFlare/1.0",
  };

  // Step 1: get default branch
  const repoRes = await fetch(
    `https://api.github.com/repos/${repoFullName}`,
    { headers: ghHeaders },
  );
  if (!repoRes.ok) {
    throw new Error(`GitHub /repos/${repoFullName}: ${repoRes.status}`);
  }
  const repoData = (await repoRes.json()) as { default_branch: string };
  const branch = repoData.default_branch;

  // Step 2: recursive tree
  const treeRes = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/trees/${branch}?recursive=1`,
    { headers: ghHeaders },
  );
  if (!treeRes.ok) {
    throw new Error(
      `GitHub tree for ${repoFullName}@${branch}: ${treeRes.status}`,
    );
  }
  const treeData = (await treeRes.json()) as {
    tree: RepoTreeFile[];
    truncated?: boolean;
  };

  // Filter to blobs only, skip SKIP_DIRS
  const files = treeData.tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        !SKIP_DIRS.some((dir) => entry.path.startsWith(`${dir}/`)),
    )
    .map((entry) => entry.path)
    .sort();

  return { branch, files };
}

/**
 * Fetch raw content of a single file from GitHub.
 * Returns null on 404, binary content, or when content exceeds maxBytes.
 */
export async function fetchFileContents(
  token: string,
  repoFullName: string,
  branch: string,
  filePath: string,
  maxBytes = MAX_FILE_CHARS,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/contents/${filePath}?ref=${branch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "ShipFlare/1.0",
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const text = await res.text().catch(() => null);
  if (!text) return null;
  return text.slice(0, maxBytes);
}

// ─── Manifest Parsing (verbatim logic from Railway) ─────────────────────────

export function extractTomlField(
  content: string,
  field: string,
): string | null {
  const match = content.match(new RegExp(`${field}\\s*=\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

async function readManifest(
  files: string[],
  readFile: (path: string, maxBytes?: number) => Promise<string | null>,
): Promise<ManifestInfo | null> {
  for (const { filename, type } of MANIFEST_FILES) {
    if (!files.includes(filename)) continue;
    const content = await readFile(filename, 10_000);
    if (!content) continue;

    if (type === "package.json") {
      try {
        const pkg = JSON.parse(content) as {
          name?: string;
          description?: string;
          keywords?: string[];
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return {
          type,
          name: pkg.name ?? null,
          description: pkg.description ?? null,
          keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
          dependencies: [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
          ],
        };
      } catch {
        continue;
      }
    }

    // For non-JSON manifests, extract what we can
    return {
      type,
      name: extractTomlField(content, "name"),
      description: extractTomlField(content, "description"),
      keywords: [],
      dependencies: [],
    };
  }

  return null;
}

// ─── Tech Stack Detection (verbatim from Railway) ──────────────────────────

export function detectTechStack(
  files: string[],
  manifest: ManifestInfo | null,
): TechStack {
  const extCounts = new Map<string, number>();
  for (const file of files) {
    const dotIdx = file.lastIndexOf(".");
    if (dotIdx === -1) continue;
    const ext = file.slice(dotIdx).toLowerCase();
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }

  const languages: string[] = [];
  const langMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".dart": "dart",
    ".swift": "swift",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".h": "cpp",
  };

  for (const [ext, lang] of Object.entries(langMap)) {
    if (extCounts.has(ext) && !languages.includes(lang)) {
      languages.push(lang);
    }
  }

  const frameworks: string[] = [];
  const deps = manifest?.dependencies ?? [];
  const frameworkMap: Record<string, string> = {
    next: "nextjs",
    react: "react",
    vue: "vue",
    svelte: "svelte",
    angular: "angular",
    express: "express",
    fastify: "fastify",
    django: "django",
    flask: "flask",
    fastapi: "fastapi",
    actix: "actix",
    rocket: "rocket",
    gin: "gin",
    echo: "echo",
    flutter: "flutter",
  };
  for (const [pkg, fw] of Object.entries(frameworkMap)) {
    if (deps.some((d) => d === pkg || d.startsWith(`@${pkg}/`))) {
      frameworks.push(fw);
    }
  }

  if (files.some((f) => f.includes("next.config"))) {
    if (!frameworks.includes("nextjs")) frameworks.push("nextjs");
  }

  return {
    languages: [...new Set(languages)],
    frameworks: [...new Set(frameworks)],
    packageManager:
      manifest?.type === "package.json"
        ? files.includes("pnpm-lock.yaml")
          ? "pnpm"
          : files.includes("yarn.lock")
            ? "yarn"
            : files.includes("bun.lockb")
              ? "bun"
              : "npm"
        : manifest?.type === "Cargo.toml"
          ? "cargo"
          : manifest?.type === "pyproject.toml"
            ? "pip"
            : manifest?.type === "go.mod"
              ? "go"
              : manifest?.type === "pubspec.yaml"
                ? "pub"
                : null,
    hasTests: files.some(
      (f) =>
        f.includes(".test.") ||
        f.includes(".spec.") ||
        f.includes("__tests__") ||
        f.includes("tests/") ||
        f.includes("test/"),
    ),
    hasCi: files.some(
      (f) =>
        f.startsWith(".github/workflows/") ||
        f === ".gitlab-ci.yml" ||
        f.includes("Jenkinsfile") ||
        f === ".circleci/config.yml",
    ),
    hasDocker: files.some(
      (f) => f === "Dockerfile" || f.includes("docker-compose"),
    ),
  };
}

// ─── File Tree Builder (verbatim from Railway) ─────────────────────────────

export function buildFileTree(files: string[]): FileNode[] {
  const root: FileNode[] = [];
  const dirMap = new Map<string, FileNode>();

  for (const filePath of files) {
    const parts = filePath.split("/");
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const fullPath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      const existing = currentLevel.find((n) => n.name === part);
      if (existing) {
        currentLevel = existing.children ?? [];
      } else {
        const node: FileNode = {
          name: part!,
          path: fullPath,
          type: isFile ? "file" : "directory",
          ...(isFile ? {} : { children: [] }),
        };
        currentLevel.push(node);
        if (!isFile) {
          dirMap.set(fullPath, node);
          currentLevel = node.children!;
        }
      }
    }
  }

  return root;
}

// ─── Key File Selection (adapted: micromatch replaces fast-glob) ─────────────

async function selectAndReadKeyFiles(
  files: string[],
  readFile: (path: string, maxBytes?: number) => Promise<string | null>,
): Promise<KeyFile[]> {
  const selected = new Set<string>();

  for (const glob of KEY_FILE_GLOBS) {
    if (selected.size >= MAX_KEY_FILES) break;
    const matched = micromatch(files, glob, { dot: false }).sort();
    for (const file of matched) {
      if (selected.size >= MAX_KEY_FILES) break;
      // Skip README (read separately with larger limit)
      if (file.toLowerCase().startsWith("readme")) continue;
      selected.add(file);
    }
  }

  const out: KeyFile[] = [];
  for (const p of selected) {
    const c = await readFile(p, MAX_FILE_CHARS);
    if (c) out.push({ path: p, content: c });
  }
  return out;
}

// ─── Claude Analysis (adapted: direct Anthropic SDK call) ───────────────────

async function analyzeCodebase(
  params: {
    readme: string | null;
    manifest: ManifestInfo | null;
    keyFiles: KeyFile[];
    techStack: TechStack;
  },
  anthropicApiKey: string,
): Promise<ProductAnalysis> {
  const sections = [
    params.techStack.languages.length > 0
      ? `Tech Stack: ${params.techStack.languages.join(", ")} / ${params.techStack.frameworks.join(", ")}`
      : "",
    params.manifest?.name ? `Package Name: ${params.manifest.name}` : "",
    params.manifest?.description
      ? `Package Description: ${params.manifest.description}`
      : "",
    params.manifest?.keywords.length
      ? `Package Keywords: ${params.manifest.keywords.join(", ")}`
      : "",
    params.readme ? `\nREADME:\n${params.readme}` : "",
    ...params.keyFiles.map((f) => `\n--- ${f.path} ---\n${f.content}`),
  ].filter(Boolean);

  const content = sections.join("\n");

  try {
    const client = getAnthropic(anthropicApiKey);
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: CODEBASE_ANALYZE_PROMPT,
      messages: [{ role: "user", content }],
    });
    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
    return {
      productName:
        parsed.productName || params.manifest?.name || "Unknown",
      oneLiner:
        parsed.oneLiner || params.manifest?.description || "",
      targetAudience: parsed.targetAudience || "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      valueProp: parsed.valueProp || "",
    };
  } catch {
    return {
      productName: params.manifest?.name || "Unknown",
      oneLiner: params.manifest?.description || "",
      targetAudience: "",
      keywords: params.manifest?.keywords ?? [],
      valueProp: "",
    };
  }
}

// ─── Main Scan Entry ────────────────────────────────────────────────────────

/**
 * Scan a GitHub repository to understand the product it builds.
 * Workers-compatible: uses GitHub REST API instead of git clone + node:fs.
 * micromatch replaces fast-glob for glob matching.
 *
 * @param repoFullName  e.g. "owner/repo"
 * @param token         GitHub OAuth access token
 * @param anthropicApiKey  Anthropic API key for LLM analysis
 * @param onPhase       Optional callback invoked at each pipeline phase
 */
export async function scanRepo(
  repoFullName: string,
  token: string,
  anthropicApiKey: string,
  onPhase?: (
    phase:
      | "fetching_tree"
      | "reading_manifest"
      | "reading_key_files"
      | "analyzing",
  ) => void,
): Promise<ScanResult & { url: string }> {
  onPhase?.("fetching_tree");
  const { branch, files } = await fetchRepoTree(token, repoFullName);

  const readFile = (p: string, max = MAX_FILE_CHARS) =>
    fetchFileContents(token, repoFullName, branch, p, max);

  onPhase?.("reading_manifest");
  const [readme, manifest] = await Promise.all([
    readFile("README.md", MAX_README_CHARS).catch(() => null),
    readManifest(files, readFile),
  ]);
  const techStack = detectTechStack(files, manifest);

  onPhase?.("reading_key_files");
  const keyFiles = await selectAndReadKeyFiles(files, readFile);

  onPhase?.("analyzing");
  const productAnalysis = await analyzeCodebase(
    { readme, manifest, keyFiles, techStack },
    anthropicApiKey,
  );

  return {
    url: `https://github.com/${repoFullName}`,
    techStack,
    fileTree: buildFileTree(files),
    readme,
    manifest,
    keyFiles,
    productAnalysis,
  };
}
