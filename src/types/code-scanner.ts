export interface TechStack {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  hasTests: boolean;
  hasCi: boolean;
  hasDocker: boolean;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

export interface KeyFile {
  path: string;
  content: string;
}

export interface ManifestInfo {
  type: 'package.json' | 'Cargo.toml' | 'pyproject.toml' | 'go.mod' | 'pubspec.yaml';
  name: string | null;
  description: string | null;
  keywords: string[];
  dependencies: string[];
}

export interface ScanResult {
  techStack: TechStack;
  fileTree: FileNode[];
  readme: string | null;
  manifest: ManifestInfo | null;
  keyFiles: KeyFile[];
  productAnalysis: ProductAnalysis;
}

export interface ProductAnalysis {
  productName: string;
  oneLiner: string;
  targetAudience: string;
  keywords: string[];
  valueProp: string;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  description: string | null;
  homepage: string | null;
  language: string | null;
  stargazersCount: number;
  pushedAt: string;
}
