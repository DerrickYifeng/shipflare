'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface VoiceProfile {
  id: string;
  userId: string;
  channel: string;
  register: 'builder_log' | 'operator_essay' | 'shitposter' | 'thought_leader' | 'researcher';
  pronouns: 'i' | 'we' | 'you_direct';
  capitalization: 'sentence' | 'lowercase' | 'title';
  emojiPolicy: 'none' | 'sparing' | 'signature';
  signatureEmoji: string | null;
  punctuationSignatures: string[];
  humorRegister: string[];
  bannedWords: string[];
  bannedPhrases: string[];
  worldviewTags: string[];
  openerPreferences: string[];
  closerPolicy: 'question' | 'cta' | 'payoff' | 'silent_stop';
  voiceStrength: 'loose' | 'moderate' | 'strict';
  extractedStyleCardMd: string | null;
  lastExtractedAt: string | null;
  extractionVersion: number;
  styleCardEdited: boolean;
  sampleTweets: Array<{ id: string; text: string; engagement: number }>;
}

export interface VoiceProfileUpdate
  extends Partial<
    Omit<
      VoiceProfile,
      'id' | 'userId' | 'lastExtractedAt' | 'extractionVersion' | 'styleCardEdited' | 'sampleTweets'
    >
  > {
  markEdited?: boolean;
}

export function useVoiceProfile(channel: string = 'x') {
  const { data, error, isLoading, mutate } = useSWR<{ profile: VoiceProfile }>(
    `/api/voice-profile?channel=${channel}`,
    fetcher,
  );

  const update = useCallback(
    async (patch: VoiceProfileUpdate) => {
      const res = await fetch('/api/voice-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ...patch }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Failed to save voice profile');
      }
      await mutate();
    },
    [channel, mutate],
  );

  const triggerExtract = useCallback(async () => {
    const res = await fetch('/api/voice-profile/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? 'Failed to trigger extraction');
    }
  }, [channel]);

  return {
    profile: data?.profile,
    isLoading,
    error,
    update,
    triggerExtract,
    refresh: mutate,
  };
}
