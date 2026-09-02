import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface Props {
  reason: string;
  onDeny: (note: string) => void;
}

/**
 * Denying is deliberately two steps: it ends the agent's request, and the note
 * is the only thing the agent is told about why.
 */
export function DenyDialog({ reason, onDeny }: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          Deny
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deny this request?</DialogTitle>
          <DialogDescription>
            The agent asked for: “{reason}”. It will be told the request was
            declined, and will not get a pane.
          </DialogDescription>
        </DialogHeader>
        <input
          autoFocus
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder="Reason (optional) — the agent sees this"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onDeny(note);
              setOpen(false);
            }}
          >
            Deny request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
