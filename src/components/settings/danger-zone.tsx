'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { signOut } from 'next-auth/react';

export function DangerZone() {
  const [showDialog, setShowDialog] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    if (confirmation !== 'DELETE') return;
    setLoading(true);

    try {
      await fetch('/api/account', { method: 'DELETE' });
      await signOut({ callbackUrl: '/' });
    } catch {
      setLoading(false);
    }
  };

  return (
    <section>
      <h2 className="text-[15px] font-semibold text-sf-error mb-4">Danger zone</h2>
      <div className="p-4 border border-sf-error/20 rounded-[var(--radius-sf-lg)]">
        <p className="text-[13px] text-sf-text-secondary mb-3">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>
        <Button variant="danger" onClick={() => setShowDialog(true)}>
          Delete account
        </Button>
      </div>

      <Dialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        title="Delete account"
      >
        <p className="text-[13px] text-sf-text-secondary mb-4">
          This will permanently delete your account, all products, drafts, posts, and
          connected accounts. Type <strong>DELETE</strong> to confirm.
        </p>
        <Input
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder="Type DELETE"
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setShowDialog(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={confirmation !== 'DELETE' || loading}
            onClick={handleDelete}
          >
            {loading ? 'Deleting...' : 'Delete permanently'}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
