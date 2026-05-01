// SkillTool roster — string description appended to the tool's API description
// so the model sees what skills exist and can pick one.

import { getAllSkills } from './registry';

export async function renderSkillRoster(): Promise<string> {
  const skills = await getAllSkills();
  if (skills.length === 0) {
    return 'No skills registered or available.';
  }

  const lines: string[] = ['Available skills:', ''];
  for (const s of skills) {
    lines.push(`### ${s.name}`);
    lines.push(s.description.trim());
    if (s.whenToUse) {
      lines.push('');
      lines.push(`When to use: ${s.whenToUse.trim()}`);
    }
    if (s.argumentHint) {
      lines.push(`Args: ${s.argumentHint}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build SkillTool's full description string. Static prefix + dynamic
 * skill roster (re-rendered on every call so newly registered skills
 * become visible without restarting).
 */
export async function getSkillToolDescription(): Promise<string> {
  const roster = await renderSkillRoster();
  return `Invoke a registered skill by name. Skills are reusable prompt units that can run inline (injected into this conversation) or as a forked sub-agent (isolated token budget).

${roster}

Pass arguments via the optional \`args\` field. The skill body uses $ARGUMENTS or $0/$1 placeholders to consume them.`;
}
