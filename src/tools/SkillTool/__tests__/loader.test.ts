import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadSkill, loadSkillsDir } from '@/tools/SkillTool/loadSkillsDir';

const FIXTURES = path.resolve(__dirname, 'fixtures');

describe('loadSkill (single)', () => {
  it('parses a valid SKILL.md', async () => {
    const skill = await loadSkill(path.join(FIXTURES, 'valid-skill'));
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('valid-skill');
    expect(skill!.description).toContain('fully populated');
    expect(skill!.context).toBe('inline');
    expect(skill!.allowedTools).toEqual(['validate_draft', 'draft_reply']);
    expect(skill!.argumentHint).toBe('<input>');
    expect(skill!.source).toBe('file');
    expect(skill!.skillRoot).toBe(path.join(FIXTURES, 'valid-skill'));
    expect(skill!.sourcePath).toBe(
      path.join(FIXTURES, 'valid-skill', 'SKILL.md'),
    );
  });

  it('returns a callable getPromptForCommand that substitutes $ARGUMENTS', async () => {
    const skill = await loadSkill(path.join(FIXTURES, 'valid-skill'));
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const rendered = await skill!.getPromptForCommand('test-args', fakeCtx);
    expect(rendered).toContain('Echo back: test-args');
  });

  it('throws when SKILL.md is malformed (missing required field)', async () => {
    await expect(
      loadSkill(path.join(FIXTURES, 'malformed-skill')),
    ).rejects.toThrow();
  });

  it('defaults context to "inline" when omitted', async () => {
    const skill = await loadSkill(path.join(FIXTURES, 'nested', 'grouped-skill'));
    expect(skill!.context).toBe('inline');
    expect(skill!.allowedTools).toEqual([]);
  });
});

describe('loadSkill references inlining', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('inlines `references:` entries as `## <name>` sections', async () => {
    const skillDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-refs-'),
    );
    tmpDirs.push(skillDir);
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: refs-skill
description: Skill that pulls in a reference file.
references:
  - check
---

# Body

Echo: $ARGUMENTS
`,
      'utf8',
    );
    await fs.writeFile(
      path.join(skillDir, 'references', 'check.md'),
      'Check content',
      'utf8',
    );

    const skill = await loadSkill(skillDir);
    expect(skill).not.toBeNull();
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const rendered = await skill!.getPromptForCommand('args', fakeCtx);
    expect(rendered).toContain('# Body');
    expect(rendered).toContain('Echo: args');
    expect(rendered).toContain('## check\n\nCheck content');
  });

  it('throws a clear error when a referenced file is missing', async () => {
    const skillDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-refs-missing-'),
    );
    tmpDirs.push(skillDir);
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: missing-ref-skill
description: References a file that does not exist.
references:
  - nope
---

# Body
`,
      'utf8',
    );

    await expect(loadSkill(skillDir)).rejects.toThrow(/missing file "nope"/);
  });
});

describe('loadSkillsDir (aggregate)', () => {
  it('discovers SKILL.md recursively, sorted by name', async () => {
    const skills = await loadSkillsDir(FIXTURES);
    const names = skills.map((s) => s.name);
    expect(names).toContain('valid-skill');
    expect(names).toContain('grouped-skill');
    expect(names).toEqual([...names].sort());
  });

  it('skips malformed siblings while keeping valid ones (per-skill failure isolation)', async () => {
    const skills = await loadSkillsDir(FIXTURES);
    const names = skills.map((s) => s.name);
    // valid-skill loaded successfully alongside malformed-skill in the same root.
    expect(names).toContain('valid-skill');
    // malformed-skill is silently skipped, not present in the result.
    expect(names).not.toContain('malformed-skill');
    // grouped-skill (nested fixture) also survives — guards against an empty
    // result silently passing the assertions above.
    expect(names).toContain('grouped-skill');
  });
});
