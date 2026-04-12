'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface ConnectionsSectionProps {
  redditConnected: boolean;
  redditUsername: string | null;
}

export function ConnectionsSection({ redditConnected, redditUsername }: ConnectionsSectionProps) {
  const handleConnect = () => {
    window.location.href = '/api/reddit/connect';
  };

  const handleDisconnect = async () => {
    await fetch('/api/reddit/disconnect', { method: 'DELETE' });
    window.location.reload();
  };

  return (
    <section>
      <h2 className="text-[15px] font-semibold text-sf-text-primary mb-4">Connections</h2>
      <div className="flex items-center justify-between p-4 border border-sf-border rounded-[var(--radius-sf-lg)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-sf-accent-light rounded-[var(--radius-sf-md)] flex items-center justify-center">
            <span className="text-[15px]">R</span>
          </div>
          <div>
            <p className="text-[13px] font-medium text-sf-text-primary">Reddit</p>
            {redditConnected && redditUsername && (
              <p className="text-[11px] text-sf-text-tertiary">u/{redditUsername}</p>
            )}
          </div>
          <Badge variant={redditConnected ? 'success' : 'default'}>
            {redditConnected ? 'Connected' : 'Not connected'}
          </Badge>
        </div>
        {redditConnected ? (
          <Button variant="ghost" onClick={handleDisconnect}>
            Disconnect
          </Button>
        ) : (
          <Button variant="secondary" onClick={handleConnect}>
            Connect
          </Button>
        )}
      </div>
    </section>
  );
}
