'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { OriginalContentEmbed } from './original-content-embed';
import type { TodoItem } from '@/hooks/use-today';

interface ReplyCardProps {
  item: TodoItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
}

const priorityBorder: Record<string, string> = {
  time_sensitive: 'border-l-4 border-l-sf-error shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]',
  scheduled: 'border-l-4 border-l-sf-accent shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]',
  optional: 'shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]',
};

export function ReplyCard({ item, onApprove, onSkip, onEdit }: ReplyCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(item.draftBody ?? '');

  const handleSaveEdit = () => {
    onEdit(item.id, editBody);
    setIsEditing(false);
  };

  const hasThreadContext = item.threadUrl || item.threadBody || item.threadTitle;

  return (
    <div
      className={`rounded-[var(--radius-sf-lg)] p-4 bg-sf-bg-secondary animate-sf-fade-in ${priorityBorder[item.priority] ?? 'shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]'}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary uppercase">
            {item.platform === 'x' ? '𝕏' : item.platform}
          </span>

          {item.community && (
            <Badge variant="accent">{item.community}</Badge>
          )}

          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary uppercase">
            reply
          </span>

          {item.confidence != null && (
            <Badge mono variant={item.confidence >= 0.7 ? 'success' : 'default'}>
              {(item.confidence * 100).toFixed(0)}%
            </Badge>
          )}
        </div>

        {item.priority === 'time_sensitive' && (
          <span className="inline-block w-2 h-2 rounded-full bg-sf-error animate-pulse shrink-0" />
        )}
      </div>

      {/* Original content embed */}
      {hasThreadContext && (
        <div className="mb-3">
          <OriginalContentEmbed
            author={item.threadAuthor}
            body={item.threadBody}
            title={item.threadTitle}
            url={item.threadUrl ?? item.externalUrl ?? '#'}
            platform={item.platform}
            postedAt={item.threadPostedAt}
            upvotes={item.threadUpvotes}
            commentCount={item.threadCommentCount}
          />
        </div>
      )}

      {/* Fallback: title only when no thread context */}
      {!hasThreadContext && item.title && (
        <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary line-clamp-2 mb-2">
          {item.externalUrl ? (
            <a
              href={item.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-sf-accent transition-colors duration-200"
            >
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </p>
      )}

      {/* Draft reply */}
      {item.draftBody && !isEditing && (
        <div className="rounded-[var(--radius-sf-md)] p-3 mb-3 bg-[#f5f5f7]">
          <p className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-tertiary uppercase mb-1.5">
            Your reply
          </p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed whitespace-pre-wrap">
            {item.draftBody}
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
          <div className="flex gap-2 mt-2">
            <Button onClick={handleSaveEdit}>Save</Button>
            <Button variant="ghost" onClick={() => setIsEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
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
          <Button onClick={() => onApprove(item.id)}>Send</Button>
          {item.draftBody && (
            <Button variant="ghost" onClick={() => setIsEditing(true)}>
              Edit
            </Button>
          )}
          <Button variant="ghost" onClick={() => onSkip(item.id)}>
            Skip
          </Button>
        </div>
      )}
    </div>
  );
}
