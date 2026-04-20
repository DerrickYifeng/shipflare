'use client';

import { useState } from 'react';
import { useVoiceProfile, type VoiceProfile, type VoiceProfileUpdate } from '@/hooks/use-voice-profile';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

const ARCHETYPES: Array<{ id: VoiceProfile['register']; label: string; blurb: string }> = [
  { id: 'builder_log', label: 'Builder log', blurb: 'Short ship-updates, numbers, demo clips.' },
  { id: 'operator_essay', label: 'Operator essay', blurb: 'Mid-length reflections on how to run things.' },
  { id: 'shitposter', label: 'Shitposter', blurb: 'Dry wit, absurdist observations, one-liners.' },
  { id: 'thought_leader', label: 'Thought leader', blurb: 'Frameworks, aphorisms, worldview-stating.' },
  { id: 'researcher', label: 'Researcher', blurb: 'Data-first, cited claims, careful hedges.' },
];

const PRONOUNS: Array<{ value: VoiceProfile['pronouns']; label: string }> = [
  { value: 'i', label: 'I (solo)' },
  { value: 'we', label: 'We (team)' },
  { value: 'you_direct', label: 'You (addressing reader)' },
];

const CAPITALIZATION: Array<{ value: VoiceProfile['capitalization']; label: string }> = [
  { value: 'sentence', label: 'Sentence case' },
  { value: 'lowercase', label: 'all lowercase' },
  { value: 'title', label: 'Title Case' },
];

const EMOJI_POLICY: Array<{ value: VoiceProfile['emojiPolicy']; label: string }> = [
  { value: 'none', label: 'Never' },
  { value: 'sparing', label: 'Sparing (≤1 / tweet)' },
  { value: 'signature', label: 'Signature emoji' },
];

const HUMOR_OPTIONS = ['self_deprecating', 'dry', 'absurdist', 'meme', 'none'] as const;
const WORLDVIEW_OPTIONS = [
  'pro_craft',
  'anti_hype',
  'pro_hustle',
  'pro_calm',
  'contrarian',
  'pro_open_source',
] as const;
const VOICE_STRENGTH: VoiceProfile['voiceStrength'][] = ['loose', 'moderate', 'strict'];
const BANNED_SUGGESTIONS = [
  'delve',
  'leverage',
  'utilize',
  'robust',
  'crucial',
  'demystify',
  'landscape',
  'seamless',
];

function readableLabel(tag: string): string {
  return tag.replace(/_/g, ' ');
}

export function VoiceSection() {
  const { profile, isLoading, update, triggerExtract } = useVoiceProfile('x');
  const { toast } = useToast();
  const [draft, setDraft] = useState<VoiceProfileUpdate>({});
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [styleCardDraft, setStyleCardDraft] = useState<string | null>(null);
  const [newBannedWord, setNewBannedWord] = useState('');

  if (isLoading || !profile) {
    return (
      <section>
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">Voice</h2>
        <Skeleton className="h-64 w-full" />
      </section>
    );
  }

  const merged: VoiceProfile = { ...profile, ...draft } as VoiceProfile;

  // Style card has its own draft so we can mark styleCardEdited on save
  const styleCardValue = styleCardDraft ?? merged.extractedStyleCardMd ?? '';
  const styleCardDirty =
    styleCardDraft !== null && styleCardDraft !== (profile.extractedStyleCardMd ?? '');
  const hasChanges = Object.keys(draft).length > 0 || styleCardDirty;

  const patch = <K extends keyof VoiceProfileUpdate>(key: K, value: VoiceProfileUpdate[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const toggleInList = <
    K extends 'humorRegister' | 'worldviewTags' | 'punctuationSignatures' | 'bannedWords',
  >(
    key: K,
    value: string,
  ) => {
    const current = (merged[key] as string[]) ?? [];
    const next = current.includes(value)
      ? current.filter((x) => x !== value)
      : [...current, value];
    patch(key, next as VoiceProfile[K]);
  };

  const addBannedWord = () => {
    const word = newBannedWord.trim().toLowerCase();
    if (!word) return;
    const current = merged.bannedWords ?? [];
    if (current.includes(word)) {
      setNewBannedWord('');
      return;
    }
    patch('bannedWords', [...current, word]);
    setNewBannedWord('');
  };

  const handleSave = async () => {
    if (!hasChanges) return;
    setSaving(true);
    try {
      const payload: VoiceProfileUpdate = { ...draft };
      if (styleCardDirty) {
        payload.extractedStyleCardMd = styleCardDraft!;
        payload.markEdited = true;
      }
      await update(payload);
      setDraft({});
      setStyleCardDraft(null);
      toast('Voice profile saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleExtract = async () => {
    setExtracting(true);
    try {
      await triggerExtract();
      toast('Voice analysis queued — runs in the background', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to start extraction', 'error');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary">Voice</h2>
        {profile.styleCardEdited && (
          <Badge variant="default" className="text-[11px] tracking-[-0.11px]">
            Custom style card
          </Badge>
        )}
      </div>
      <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-[1.47]">
        How ShipFlare should sound when drafting on your behalf. Changes take effect on the next
        draft.
      </p>

      {/* Archetype */}
      <div className="flex flex-col gap-2">
        <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
          Register
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ARCHETYPES.map((a) => {
            const selected = merged.register === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => patch('register', a.id)}
                className={`text-left p-3 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] border shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] ${
                  selected ? 'border-sf-text-primary' : 'border-transparent'
                }`}
              >
                <div className="text-[13px] tracking-[-0.13px] font-medium text-sf-text-primary">
                  {a.label}
                </div>
                <div className="text-[11px] tracking-[-0.11px] text-sf-text-tertiary mt-0.5">
                  {a.blurb}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Pronouns / Capitalization / Emoji grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
            Pronouns
          </label>
          <select
            value={merged.pronouns}
            onChange={(e) => patch('pronouns', e.target.value as VoiceProfile['pronouns'])}
            className="h-9 px-2 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] text-[13px] text-sf-text-primary border border-transparent focus:border-sf-text-primary outline-none"
          >
            {PRONOUNS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
            Capitalization
          </label>
          <select
            value={merged.capitalization}
            onChange={(e) =>
              patch('capitalization', e.target.value as VoiceProfile['capitalization'])
            }
            className="h-9 px-2 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] text-[13px] text-sf-text-primary border border-transparent focus:border-sf-text-primary outline-none"
          >
            {CAPITALIZATION.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
            Emoji policy
          </label>
          <select
            value={merged.emojiPolicy}
            onChange={(e) => patch('emojiPolicy', e.target.value as VoiceProfile['emojiPolicy'])}
            className="h-9 px-2 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] text-[13px] text-sf-text-primary border border-transparent focus:border-sf-text-primary outline-none"
          >
            {EMOJI_POLICY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Humor register chips */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
          Humor register
        </label>
        <div className="flex flex-wrap gap-1.5">
          {HUMOR_OPTIONS.map((opt) => {
            const selected = (merged.humorRegister ?? []).includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggleInList('humorRegister', opt)}
                className={`px-2.5 h-7 rounded-full text-[12px] tracking-[-0.12px] border ${
                  selected
                    ? 'bg-sf-text-primary text-white border-sf-text-primary'
                    : 'bg-sf-bg-secondary text-sf-text-secondary border-transparent'
                }`}
              >
                {readableLabel(opt)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Worldview chips */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
          Worldview
        </label>
        <div className="flex flex-wrap gap-1.5">
          {WORLDVIEW_OPTIONS.map((opt) => {
            const selected = (merged.worldviewTags ?? []).includes(opt);
            return (
              <button
                key={opt}
                type="button"
                onClick={() => toggleInList('worldviewTags', opt)}
                className={`px-2.5 h-7 rounded-full text-[12px] tracking-[-0.12px] border ${
                  selected
                    ? 'bg-sf-text-primary text-white border-sf-text-primary'
                    : 'bg-sf-bg-secondary text-sf-text-secondary border-transparent'
                }`}
              >
                {readableLabel(opt)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Banned words */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
          Words you never want ShipFlare to use
        </label>
        {/* Suggestion chips */}
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {BANNED_SUGGESTIONS.map((w) => {
            const selected = (merged.bannedWords ?? []).includes(w);
            return (
              <button
                key={w}
                type="button"
                onClick={() => toggleInList('bannedWords', w)}
                className={`px-2.5 h-7 rounded-full text-[12px] tracking-[-0.12px] border ${
                  selected
                    ? 'bg-sf-text-primary text-white border-sf-text-primary'
                    : 'bg-sf-bg-secondary text-sf-text-secondary border-transparent'
                }`}
              >
                {w}
              </button>
            );
          })}
        </div>
        {/* Custom word chips (not in suggestion list) */}
        {(merged.bannedWords ?? []).filter((w) => !BANNED_SUGGESTIONS.includes(w)).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {(merged.bannedWords ?? [])
              .filter((w) => !BANNED_SUGGESTIONS.includes(w))
              .map((w) => (
                <span
                  key={w}
                  className="px-2.5 h-7 inline-flex items-center gap-1 rounded-full text-[12px] tracking-[-0.12px] bg-sf-text-primary text-white"
                >
                  {w}
                  <button
                    type="button"
                    onClick={() => toggleInList('bannedWords', w)}
                    className="ml-0.5 text-white/70 hover:text-white"
                    aria-label={`Remove ${w}`}
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}
        {/* Add new word input */}
        <div className="flex gap-1.5 mt-1">
          <input
            value={newBannedWord}
            onChange={(e) => setNewBannedWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addBannedWord();
              }
            }}
            placeholder="add a word…"
            className="flex-1 h-8 px-2.5 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] text-[13px] text-sf-text-primary border border-transparent focus:border-sf-text-primary outline-none"
          />
          <Button variant="ghost" onClick={addBannedWord}>
            Add
          </Button>
        </div>
      </div>

      {/* Voice strength */}
      <div className="flex flex-col gap-1.5">
        <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
          Voice strength
        </label>
        <div className="flex gap-1.5">
          {VOICE_STRENGTH.map((s) => {
            const selected = merged.voiceStrength === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => patch('voiceStrength', s)}
                className={`flex-1 h-9 rounded-[var(--radius-sf-md)] text-[13px] tracking-[-0.13px] font-medium border ${
                  selected
                    ? 'bg-sf-text-primary text-white border-sf-text-primary'
                    : 'bg-sf-bg-secondary text-sf-text-secondary border-transparent'
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] tracking-[-0.11px] text-sf-text-tertiary">
          {merged.voiceStrength === 'loose' &&
            'Structural rules only; the AI picks phrasing freely.'}
          {merged.voiceStrength === 'moderate' &&
            'Include your style card + example tweets. Recommended.'}
          {merged.voiceStrength === 'strict' &&
            'Enforce banned phrases too; tightest voice match.'}
        </p>
      </div>

      {/* Extracted style card */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-primary">
            Style card
          </label>
          {profile.lastExtractedAt && (
            <span className="text-[11px] tracking-[-0.11px] text-sf-text-tertiary">
              v{profile.extractionVersion} ·{' '}
              {new Date(profile.lastExtractedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <textarea
          value={styleCardValue}
          onChange={(e) => setStyleCardDraft(e.target.value)}
          rows={10}
          placeholder="Run voice analysis to auto-generate, or write your own markdown style card here."
          className="w-full p-3 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] text-[13px] text-sf-text-primary font-mono leading-[1.5] border border-transparent focus:border-sf-text-primary outline-none resize-y min-h-[180px]"
        />
        <p className="text-[11px] tracking-[-0.11px] text-sf-text-tertiary">
          Editing this marks your card as custom — re-analysis will keep your edits and only
          refresh samples.
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <Button onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={handleExtract} disabled={extracting}>
          {extracting ? 'Queuing…' : 'Re-analyse my voice'}
        </Button>
      </div>
    </section>
  );
}
