import { useEffect } from 'react';
import { Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { RequestCard } from '@/components/request-card';
import { useRequests } from '@/hooks/use-requests';
import { cn } from '@/lib/utils';

function ConnectionDot({ state }: { state: 'connecting' | 'live' | 'offline' }) {
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="relative flex size-2">
        {state === 'live' && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-60" />
        )}
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            state === 'live' ? 'bg-live' : state === 'connecting' ? 'bg-muted-foreground' : 'bg-destructive'
          )}
        />
      </span>
      {label}
    </span>
  );
}

export default function App() {
  const { requests, connection, error, refresh, onArrived } = useRequests();

  useEffect(() => {
    onArrived(reason => {
      toast('An agent wants a pane', { description: reason });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('tmux-mcp: an agent wants a pane', { body: reason });
      }
    });
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, [onArrived]);

  const pending = requests?.length ?? 0;

  return (
    <div className="aurora min-h-dvh">
      <div className="mx-auto w-full max-w-3xl px-5 py-10">
        <header className="mb-8 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">tmux-mcp</h1>
            <p className="text-sm text-muted-foreground">
              {pending === 0 ? 'No agent is waiting' : `${pending} request${pending === 1 ? '' : 's'} waiting`}
            </p>
          </div>
          <ConnectionDot state={connection} />
        </header>

        {error && (
          <p className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            {error}
          </p>
        )}

        {requests === null ? null : requests.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 py-20 text-center">
            <Inbox className="size-8 text-muted-foreground/60" />
            <p className="text-sm font-medium">Nothing is waiting</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              When an agent asks for a pane, it appears here by itself. You can
              leave this open.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {requests.map(request => (
              <RequestCard key={request.id} request={request} onAnswered={refresh} />
            ))}
          </div>
        )}
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
