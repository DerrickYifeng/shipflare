'use client';

import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import type { TodoItem } from '@/hooks/use-today';
import { splitXTweets } from '@/lib/content/x-thread';

interface PostCardProps {
  item: TodoItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  onReschedule?: (id: string, scheduledFor: string) => void;
  isActive?: boolean;
  forceEditing?: boolean;
  onEditDone?: () => void;
}

const priorityBorder: Record<string, string> = {
  time_sensitive: 'border-l-4 border-l-sf-error shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]',
  scheduled: 'border-l-4 border-l-sf-accent shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]',
  optional: 'shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]',
};

const contentTypeBadge: Record<string, { label: string; variant: 'default' | 'accent' | 'success' | 'warning' }> = {
  metric: { label: 'Metric', variant: 'accent' },
  educational: { label: 'Educational', variant: 'success' },
  engagement: { label: 'Engagement', variant: 'warning' },
  product: { label: 'Product', variant: 'default' },
  thread: { label: 'Thread', variant: 'accent' },
};

function formatScheduledTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function charCountColor(len: number): string {
  if (len > 270) return 'text-sf-error';
  if (len > 240) return 'text-sf-warning';
  return 'text-sf-text-tertiary';
}

export function PostCard({
  item,
  onApprove,
  onSkip,
  onEdit,
  onReschedule,
  isActive = false,
  forceEditing = false,
  onEditDone,
}: PostCardProps) {
  const [localEditing, setLocalEditing] = useState(false);
  const [editBody, setEditBody] = useState(item.draftBody ?? '');
  const [media, setMedia] = useState(item.draftMedia ?? []);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Derive edit mode from local toggle + keyboard-driven flag to avoid
  // a setState-in-effect cascade.
  const isEditing = localEditing || forceEditing;

  useEffect(() => {
    if (isActive) {
      rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  const handleSaveEdit = () => {
    onEdit(item.id, editBody);
    setLocalEditing(false);
    onEditDone?.();
  };

  const handleCancelEdit = () => {
    setLocalEditing(false);
    onEditDone?.();
  };

  const contentType = item.calendarContentType
    ? contentTypeBadge[item.calendarContentType]
    : null;

  // X posts can be a thread — the post-writer separates tweets with a
  // blank line (`\n\n`), and the server-side validator splits on the
  // same boundary to enforce the 280 cap per tweet. Mirror that split
  // here so a valid thread renders as 5 tweets each ≤280 instead of one
  // 1086-char block flagged red. Codepoint count is an approximation
  // of twitter-text's weighted length (URLs=23, emoji=2, CJK=2 there);
  // the persisted body is always weight-validated server-side, so the
  // small UI mismatch is cosmetic.
  const sourceBody = isEditing ? editBody : item.draftBody ?? '';
  const isX = item.platform === 'x';
  const xTweets = isX ? splitXTweets(sourceBody) : [];
  const isXThread = xTweets.length > 1;
  const showCharCount = isX && (item.draftBody || isEditing);
  // Single-tweet count for the non-thread path + edit-mode footer.
  const charCount = sourceBody.length;

  return (
    <div
      ref={rootRef}
      className={`rounded-[var(--radius-sf-lg)] p-4 bg-sf-bg-secondary animate-sf-fade-in ${priorityBorder[item.priority] ?? 'shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]'} ${isActive ? 'ring-2 ring-sf-accent' : ''} ${item.status !== 'pending' ? 'opacity-60 pointer-events-none' : ''}`}
      aria-busy={item.status !== 'pending' || undefined}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary uppercase">
            {item.platform === 'x' ? '𝕏' : item.platform}
          </span>

          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary uppercase">
            {contentType ? contentType.label : 'post'}
          </span>

          {item.calendarScheduledAt && (
            <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
              {formatScheduledTime(item.calendarScheduledAt)}
            </span>
          )}
        </div>

        {item.priority === 'time_sensitive' && (
          <span className="inline-block w-2 h-2 rounded-full bg-sf-error animate-pulse shrink-0" />
        )}
      </div>

      {/* Post title (for original_post type) */}
      {item.draftPostTitle && !isEditing && (
        <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary mb-2">
          {item.draftPostTitle}
        </p>
      )}

      {/* Draft body preview */}
      {item.draftBody && !isEditing && (
        isXThread ? (
          // Thread: render each tweet as its own surface with its own
          // count + position pip. Mirrors how the post will actually be
          // sent (one tweet per row). Single big block + total count was
          // misleading — a 5-tweet thread at 5 × 240 chars looked like a
          // hard-fail 1086/280 even though the validator passed it.
          <div className="mb-3 flex flex-col gap-2">
            {xTweets.map((tweet, i) => {
              const len = tweet.length;
              return (
                <div
                  key={i}
                  className="bg-[#f5f5f7] rounded-[var(--radius-sf-md)] p-3"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-mono text-[11px] tracking-[-0.11px] text-sf-text-tertiary uppercase">
                      Tweet {i + 1} / {xTweets.length}
                    </span>
                    <span
                      className={`font-mono text-[11px] tracking-[-0.11px] tabular-nums ${charCountColor(len)}`}
                    >
                      {len}/280
                    </span>
                  </div>
                  <p className="text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed whitespace-pre-wrap">
                    {tweet}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-[#f5f5f7] rounded-[var(--radius-sf-md)] p-3 mb-3">
            <p className="text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed whitespace-pre-wrap">
              {item.draftBody}
            </p>
            {showCharCount && (
              <p className={`font-mono text-[12px] tracking-[-0.12px] mt-2 tabular-nums ${charCountColor(charCount)}`}>
                {charCount}/280
              </p>
            )}
          </div>
        )
      )}

      {/* No draft yet — show topic */}
      {!item.draftBody && !isEditing && (
        <div className="bg-[#f5f5f7] rounded-[var(--radius-sf-md)] p-3 mb-3 border border-dashed border-[rgba(0,0,0,0.08)]">
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary italic">
            {item.title}
          </p>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-1">
            Draft pending
          </p>
        </div>
      )}

      {/* Edit mode */}
      {isEditing && (
        <div className="mb-3">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="w-full bg-[#f5f5f7] border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-md)] p-3 text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed resize-y min-h-[80px] focus:outline-none focus:ring-1 focus:ring-sf-accent transition-colors duration-200"
            rows={4}
          />
          {showCharCount && (
            isXThread ? (
              // While editing a thread, show one count line per tweet so
              // the user sees which segment is over the cap. The user
              // separates tweets with a blank line; that's the same
              // boundary the validator uses.
              <div className="mt-1 flex flex-col gap-0.5">
                {xTweets.map((tweet, i) => (
                  <p
                    key={i}
                    className={`font-mono text-[11px] tracking-[-0.11px] tabular-nums ${charCountColor(tweet.length)}`}
                  >
                    Tweet {i + 1}/{xTweets.length}: {tweet.length}/280
                  </p>
                ))}
              </div>
            ) : (
              <p className={`font-mono text-[12px] tracking-[-0.12px] mt-1 tabular-nums ${charCountColor(charCount)}`}>
                {charCount}/280
              </p>
            )
          )}
          <div className="flex gap-2 mt-2">
            <Button onClick={handleSaveEdit}>Save</Button>
            <Button variant="ghost" onClick={handleCancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Media strip */}
      {(media.length > 0 || item.draftId) && (
        <MediaStrip
          media={media}
          draftId={item.draftId}
          uploading={uploading}
          fileInputRef={fileInputRef}
          onUpload={async (file: File) => {
            if (!item.draftId) return;
            setUploading(true);
            try {
              const formData = new FormData();
              formData.append('file', file);
              const res = await fetch(`/api/drafts/${item.draftId}/media`, {
                method: 'POST',
                body: formData,
              });
              if (res.ok) {
                const data = await res.json();
                setMedia(data.media);
              }
            } finally {
              setUploading(false);
            }
          }}
          onRemove={async (url: string) => {
            if (!item.draftId) return;
            const res = await fetch(`/api/drafts/${item.draftId}/media`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url }),
            });
            if (res.ok) {
              const data = await res.json();
              setMedia(data.media);
            }
          }}
        />
      )}

      {/* Why it works */}
      {item.draftWhyItWorks && !isEditing && (
        <Toggle label="Why this works">
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed">
            {item.draftWhyItWorks}
          </p>
        </Toggle>
      )}

      {/* Actions */}
      {!isEditing && (
        <div className="flex items-center gap-2 mt-4">
          <Button onClick={() => onApprove(item.id)}>
            {item.draftBody ? 'Approve' : 'Approve Topic'}
          </Button>
          {item.draftBody && (
            <Button variant="ghost" onClick={() => setLocalEditing(true)}>
              Edit
            </Button>
          )}
          <Button variant="ghost" onClick={() => onSkip(item.id)}>
            Skip
          </Button>
          {item.source === 'calendar' && onReschedule && (
            <Button
              variant="ghost"
              onClick={() => {
                // Simple reschedule: advance by 1 day
                const next = new Date();
                next.setDate(next.getDate() + 1);
                onReschedule(item.id, next.toISOString());
              }}
            >
              Tomorrow
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Media strip sub-component ── */

interface MediaStripProps {
  media: Array<{ url: string; type: string; alt?: string }>;
  draftId: string | null;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (file: File) => void;
  onRemove: (url: string) => void;
}

function MediaStrip({ media, draftId, uploading, fileInputRef, onUpload, onRemove }: MediaStripProps) {
  return (
    <div className="mb-3">
      {media.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-2">
          {media.map((m) => (
            <div key={m.url} className="relative group w-20 h-20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.url}
                alt={m.alt ?? ''}
                className="w-full h-full object-cover rounded-[var(--radius-sf-md)] border border-[rgba(0,0,0,0.08)]"
              />
              <button
                type="button"
                onClick={() => onRemove(m.url)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-sf-error text-white text-[12px] tracking-[-0.12px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                aria-label="Remove media"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {draftId && media.length < 4 && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary hover:text-sf-accent transition-colors duration-200 flex items-center gap-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            {uploading ? 'Uploading...' : 'Add image'}
          </button>
        </>
      )}
    </div>
  );
}
