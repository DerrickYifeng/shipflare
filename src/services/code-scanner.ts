import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@/lib/logger';
import type {
  TechStack,
  FileNode,
  KeyFile,
  ManifestInfo,
  ScanResult,
  ProductAnalysis,
} from '@/types/code-scanner';

const log = createLogger('service:code-scanner');

const execFileAsync = promisify(execFile);

const MAX_FILE_CHARS = 3_000;
const MAX_KEY_FILES = 10;
const MAX_README_CHARS = 4_000;

// Directories to always skip
const SKIP_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.venv', 'venv', 'target', 'vendor', '.dart_tool', '.gradle',
];

// ─── Clone ──────────────────────────────────────────────────

/**
 * Shallow-clone a GitHub repo to a temp directory.
 * Returns the path to the cloned dir. Caller must clean up.
 */
export async function cloneRepo(
  repoFullName: string,
  token: string,
): Promise<string> {
  const tmpDir = path.join(
    '/tmp',
    `shipflare-scan-${crypto.randomUUID()}`,
  );
  const repoUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;

  log.info(`Cloning ${repoFullName} to ${tmpDir}`);
  await execFileAsync('git', [
    'clone', '--depth', '1', '--single-branch', repoUrl, tmpDir,
  ], { timeout: 30_000 });

  return tmpDir;
}

/**
 * Clean up a cloned repo directory.
 */
export async function cleanupClone(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    log.error(`Failed to cleanup ${dir}: ${error}`);
  }
}

// ─── File Discovery (adapted from engine GlobTool) ─────────

/**
 * Discover files in a directory, returning a flat list of relative paths.
 * Uses fast-glob (pure JS, no ripgrep binary needed).
 */
async function discoverFiles(dir: string): Promise<string[]> {
  const files = await fg('**/*', {
    cwd: dir,
    ignore: SKIP_DIRS.map((d) => `${d}/**`),
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
  });
  return files.sort();
}

/**
 * Build a simplified directory tree from a flat file list.
 */
function buildFileTree(files: string[]): FileNode[] {
  const root: FileNode[] = [];
  const dirMap = new Map<string, FileNode>();

  for (const filePath of files) {
    const parts = filePath.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const fullPath = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;

      const existing = currentLevel.find((n) => n.name === part);
      if (existing) {
        currentLevel = existing.children ?? [];
      } else {
        const node: FileNode = {
          name: part,
          path: fullPath,
          type: isFile ? 'file' : 'directory',
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

// ─── File Reading (adapted from engine FileReadTool) ────────

async function readIfExists(
  dir: string,
  filename: string,
  maxChars = MAX_FILE_CHARS,
): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(dir, filename), 'utf-8');
    return content.slice(0, maxChars);
  } catch {
    return null;
  }
}

// ─── Manifest Parsing ───────────────────────────────────────

const MANIFEST_FILES: Array<{
  filename: string;
  type: ManifestInfo['type'];
}> = [
  { filename: 'package.json', type: 'package.json' },
  { filename: 'Cargo.toml', type: 'Cargo.toml' },
  { filename: 'pyproject.toml', type: 'pyproject.toml' },
  { filename: 'go.mod', type: 'go.mod' },
  { filename: 'pubspec.yaml', type: 'pubspec.yaml' },
];

async function readManifest(dir: string): Promise<ManifestInfo | null> {
  for (const { filename, type } of MANIFEST_FILES) {
    const content = await readIfExists(dir, filename, 10_000);
    if (!content) continue;

    if (type === 'package.json') {
      try {
        const pkg = JSON.parse(content);
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
      name: extractTomlField(content, 'name'),
      description: extractTomlField(content, 'description'),
      keywords: [],
      dependencies: [],
    };
  }

  return null;
}

function extractTomlField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`${field}\\s*=\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

// ─── Tech Stack Detection ───────────────────────────────────

function detectTechStack(files: string[], manifest: ManifestInfo | null): TechStack {
  const extCounts = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }

  const languages: string[] = [];
  const langMap: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.dart': 'dart',
    '.swift': 'swift',
    '.kt': 'kotlin', '.kts': 'kotlin',
    '.java': 'java',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.cpp': 'cpp', '.cc': 'cpp', '.h': 'cpp',
  };

  for (const [ext, lang] of Object.entries(langMap)) {
    if (extCounts.has(ext) && !languages.includes(lang)) {
      languages.push(lang);
    }
  }

  const frameworks: string[] = [];
  const deps = manifest?.dependencies ?? [];
  const frameworkMap: Record<string, string> = {
    next: 'nextjs', react: 'react', vue: 'vue', svelte: 'svelte',
    angular: 'angular', express: 'express', fastify: 'fastify',
    django: 'django', flask: 'flask', fastapi: 'fastapi',
    actix: 'actix', rocket: 'rocket',
    gin: 'gin', echo: 'echo',
    flutter: 'flutter',
  };
  for (const [pkg, fw] of Object.entries(frameworkMap)) {
    if (deps.some((d) => d === pkg || d.startsWith(`@${pkg}/`))) {
      frameworks.push(fw);
    }
  }

  // Also check files for framework hints
  if (files.some((f) => f.includes('next.config'))) frameworks.push('nextjs');
  if (files.some((f) => f === 'Dockerfile' || f.includes('docker-compose'))) {
    // hasDocker handled below
  }

  return {
    languages: [...new Set(languages)],
    frameworks: [...new Set(frameworks)],
    packageManager: manifest?.type === 'package.json'
      ? (files.includes('pnpm-lock.yaml') ? 'pnpm'
        : files.includes('yarn.lock') ? 'yarn'
          : files.includes('bun.lockb') ? 'bun' : 'npm')
      : manifest?.type === 'Cargo.toml' ? 'cargo'
        : manifest?.type === 'pyproject.toml' ? 'pip'
          : manifest?.type === 'go.mod' ? 'go'
            : manifest?.type === 'pubspec.yaml' ? 'pub'
              : null,
    hasTests: files.some((f) =>
      f.includes('.test.') || f.includes('.spec.') ||
      f.includes('__tests__') || f.includes('tests/') ||
      f.includes('test/'),
    ),
    hasCi: files.some((f) =>
      f.startsWith('.github/workflows/') || f === '.gitlab-ci.yml' ||
      f.includes('Jenkinsfile') || f === '.circleci/config.yml',
    ),
    hasDocker: files.some((f) =>
      f === 'Dockerfile' || f.includes('docker-compose'),
    ),
  };
}

// ─── Key File Selection ─────────────────────────────────────

const KEY_FILE_GLOBS = [
  // Documentation
  'README*',
  // Entry points
  'src/app/page.tsx', 'src/index.ts', 'src/main.ts', 'src/main.tsx',
  'app.ts', 'main.py', 'src/lib.rs', 'cmd/*/main.go',
  // API surface
  'src/app/api/**/route.ts',
  'src/routes/**/*.ts',
  'src/api/**/*.ts',
  // Schema / types
  'src/**/*schema*.ts', 'src/**/*types*.ts', 'src/models/**/*.ts',
  // Config
  '.env.example',
  // Components (first few)
  'src/components/**/*.tsx',
];

async function selectAndReadKeyFiles(dir: string): Promise<KeyFile[]> {
  const selected = new Set<string>();

  for (const glob of KEY_FILE_GLOBS) {
    if (selected.size >= MAX_KEY_FILES) break;

    const matched = await fg(glob, {
      cwd: dir,
      ignore: SKIP_DIRS.map((d) => `${d}/**`),
      onlyFiles: true,
    });

    for (const file of matched.sort()) {
      if (selected.size >= MAX_KEY_FILES) break;
      // Skip README (read separately with larger limit)
      if (file.toLowerCase().startsWith('readme')) continue;
      selected.add(file);
    }
  }

  const keyFiles: KeyFile[] = [];
  for (const filePath of selected) {
    const content = await readIfExists(dir, filePath, MAX_FILE_CHARS);
    if (content) {
      keyFiles.push({ path: filePath, content });
    }
  }

  return keyFiles;
}

// ─── Claude Analysis ────────────────────────────────────────

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

async function analyzeCodebase(params: {
  readme: string | null;
  manifest: ManifestInfo | null;
  keyFiles: KeyFile[];
  techStack: TechStack;
}): Promise<ProductAnalysis> {
  const client = new Anthropic();

  const sections = [
    params.techStack.languages.length > 0
      ? `Tech Stack: ${params.techStack.languages.join(', ')} / ${params.techStack.frameworks.join(', ')}`
      : '',
    params.manifest?.name ? `Package Name: ${params.manifest.name}` : '',
    params.manifest?.description ? `Package Description: ${params.manifest.description}` : '',
    params.manifest?.keywords.length
      ? `Package Keywords: ${params.manifest.keywords.join(', ')}`
      : '',
    params.readme ? `\nREADME:\n${params.readme}` : '',
    ...params.keyFiles.map(
      (f) => `\n--- ${f.path} ---\n${f.content}`,
    ),
  ].filter(Boolean);

  const content = sections.join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: CODEBASE_ANALYZE_PROMPT,
      messages: [{ role: 'user', content }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as ProductAnalysis;
    return {
      productName: parsed.productName || params.manifest?.name || 'Unknown',
      oneLiner: parsed.oneLiner || params.manifest?.description || '',
      targetAudience: parsed.targetAudience || '',
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      valueProp: parsed.valueProp || '',
    };
  } catch (error) {
    log.error(`analyzeCodebase failed: ${error}`);
    return {
      productName: params.manifest?.name || 'Unknown',
      oneLiner: params.manifest?.description || '',
      targetAudience: '',
      keywords: params.manifest?.keywords ?? [],
      valueProp: '',
    };
  }
}

// ─── Main Scan Pipeline ─────────────────────────────────────

/**
 * Scan a cloned repository to understand the product it builds.
 * Adapted from engine tools: GlobTool (fast-glob), FileReadTool (fs),
 * GrepTool (regex).
 */
export async function scanRepo(repoDir: string): Promise<ScanResult> {
  log.info(`Scanning ${repoDir}`);

  // Phase 1: Structure discovery + docs + manifest (parallel)
  const [allFiles, readme, manifest] = await Promise.all([
    discoverFiles(repoDir),
    readIfExists(repoDir, 'README.md', MAX_README_CHARS),
    readManifest(repoDir),
  ]);

  log.info(`Found ${allFiles.length} files`);

  // Phase 2: Tech stack detection
  const techStack = detectTechStack(allFiles, manifest);
  log.info(`Tech stack: ${techStack.languages.join(', ')} / ${techStack.frameworks.join(', ')}`);

  // Phase 3: Read key files
  const keyFiles = await selectAndReadKeyFiles(repoDir);
  log.info(`Read ${keyFiles.length} key files`);

  // Phase 4: Claude analysis
  const productAnalysis = await analyzeCodebase({
    readme,
    manifest,
    keyFiles,
    techStack,
  });

  // Build tree (truncated to top-level + one level deep for storage)
  const fileTree = buildFileTree(allFiles);

  return {
    techStack,
    fileTree,
    readme,
    manifest,
    keyFiles,
    productAnalysis,
  };
}

// ─── Incremental Diff ──────────────────────────────────────

const DIFF_ANALYZE_PROMPT = `You analyze git commit logs and diffs to identify content-worthy updates.
Given the commit log and diff summary below, determine:
1. Whether the changes are "meaningful" for content creation (new features, notable bug fixes, milestones).
   Config changes, CI tweaks, dependency bumps, and formatting are NOT meaningful.
2. If meaningful, write a 2-3 sentence content-ready summary of what changed and why it matters to users.

Respond with ONLY a JSON object:
{"meaningful": true/false, "summary": "..."}`;

/**
 * Compare a cloned repo against a previous snapshot's commit SHA.
 * Returns whether meaningful changes exist and a content-ready summary.
 */
export async function diffRepo(
  repoDir: string,
  previousCommitSha: string | null,
): Promise<{ hasMeaningfulChanges: boolean; diffSummary: string | null; newCommitSha: string | null }> {
  const newSha = await getCommitSha(repoDir);

  if (!newSha || newSha === previousCommitSha) {
    return { hasMeaningfulChanges: false, diffSummary: null, newCommitSha: newSha };
  }

  if (!previousCommitSha) {
    // First diff — no baseline to compare against, skip
    return { hasMeaningfulChanges: false, diffSummary: null, newCommitSha: newSha };
  }

  try {
    // Get commit log between previous and current
    const { stdout: commitLog } = await execFileAsync(
      'git', ['log', '--oneline', `${previousCommitSha}..HEAD`],
      { cwd: repoDir, timeout: 10_000 },
    );

    // Get diff stats
    const { stdout: diffStat } = await execFileAsync(
      'git', ['diff', '--stat', `${previousCommitSha}..HEAD`],
      { cwd: repoDir, timeout: 10_000 },
    );

    if (!commitLog.trim()) {
      return { hasMeaningfulChanges: false, diffSummary: null, newCommitSha: newSha };
    }

    // Use Haiku to assess whether changes are content-worthy
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: DIFF_ANALYZE_PROMPT,
      messages: [{
        role: 'user',
        content: `Commit log:\n${commitLog.slice(0, 2000)}\n\nDiff stats:\n${diffStat.slice(0, 2000)}`,
      }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { hasMeaningfulChanges: false, diffSummary: null, newCommitSha: newSha };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { meaningful: boolean; summary: string };
    return {
      hasMeaningfulChanges: parsed.meaningful,
      diffSummary: parsed.meaningful ? parsed.summary : null,
      newCommitSha: newSha,
    };
  } catch (error) {
    log.error(`diffRepo failed: ${error}`);
    return { hasMeaningfulChanges: false, diffSummary: null, newCommitSha: newSha };
  }
}

/**
 * Get the HEAD commit SHA of a cloned repo.
 */
export async function getCommitSha(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
