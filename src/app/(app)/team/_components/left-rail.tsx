'use client';

import type { CSSProperties } from 'react';
import { AgentRow, type AgentRowStatus } from './agent-row';
import { TokenBudget, type BudgetSegment } from './token-budget';
import { SessionList } from './session-list';
import type { ConversationMeta } from './conversation-meta';

export interface LeftRailMember {
  id: string;
  agentType: string;
  displayName: string;
  status: AgentRowStatus | string;
  taskCount?: number;
  notes?: readonly string[];
}

export interface LeftRailProps {
  teamLead: LeftRailMember | null;
  specialists: readonly LeftRailMember[];
  activeMemberId: string | null;
  onSelect: (memberId: string) => void;
  spentUsd: number;
  weeklyBudgetUsd: number;
  budgetSegments: readonly BudgetSegment[];
  conversations: readonly ConversationMeta[];
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  canCreate: boolean;
  creating: boolean;
}

export function LeftRail({
  teamLead,
  specialists,
  activeMemberId,
  onSelect,
  spentUsd,
  weeklyBudgetUsd,
  budgetSegments,
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewConversation,
  canCreate,
  creating,
}: LeftRailProps) {
  const parallelCount = specialists.reduce(
    (n, s) => (typeof s.taskCount === 'number' ? n + s.taskCount : n),
    0,
  );

  const outer: CSSProperties = {
    position: 'sticky',
    top: 72,
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(100vh - 88px)',
    padding: 10,
    borderRadius: 12,
    background: 'var(--sf-bg-primary)',
  };

  const scroll: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: 2,
  };

  const sectionHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px 6px',
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  const sectionLeft: CSSProperties = {
    color: 'var(--sf-fg-1)',
  };

  const sectionRight: CSSProperties = {
    color: 'rgba(0, 0, 0, 0.48)',
  };

  const divider: CSSProperties = {
    height: 1,
    margin: '10px 10px',
    background: 'rgba(0, 0, 0, 0.06)',
  };

  return (
    <aside style={outer} aria-label="Team roster">
      <div style={scroll}>
        {teamLead ? (
          <>
            <div style={sectionHeader}>
              <span style={sectionLeft}>Team Lead</span>
              <span style={sectionRight}>
                {parallelCount > 0 ? `${parallelCount} parallel` : 'ready'}
              </span>
            </div>
            <AgentRow
              memberId={teamLead.id}
              agentType={teamLead.agentType}
              displayName={teamLead.displayName}
              status={teamLead.status}
              active={activeMemberId === teamLead.id}
              taskCount={teamLead.taskCount}
              notes={teamLead.notes}
              onSelect={onSelect}
            />
          </>
        ) : null}

        <div style={{ ...sectionHeader, marginTop: 8 }}>
          <span style={sectionLeft}>Specialists</span>
          <span style={sectionRight}>{`${specialists.length} seats`}</span>
        </div>
        {specialists.map((m) => (
          <AgentRow
            key={m.id}
            memberId={m.id}
            agentType={m.agentType}
            displayName={m.displayName}
            status={m.status}
            active={activeMemberId === m.id}
            taskCount={m.taskCount}
            notes={m.notes}
            onSelect={onSelect}
          />
        ))}

        <div style={divider} aria-hidden="true" />

        <SessionList
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          onSelect={onSelectConversation}
          onNewConversation={onNewConversation}
          canCreate={canCreate}
          creating={creating}
        />
      </div>

      <TokenBudget
        spentUsd={spentUsd}
        weeklyBudgetUsd={weeklyBudgetUsd}
        segments={budgetSegments}
      />
    </aside>
  );
}
