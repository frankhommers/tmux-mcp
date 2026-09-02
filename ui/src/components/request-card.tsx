import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DenyDialog } from '@/components/deny-dialog';
import { TargetRow } from '@/components/target-row';
import { deny, grant, listTargets, type PaneRequest, type Target } from '@/lib/api';

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function RequestCard({ request, onAnswered }: { request: PaneRequest; onAnswered: () => void }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { targets } = await listTargets(request.id);
      setTargets(targets);
    } catch (cause) {
      toast.error((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [request.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Arrow keys walk the list; Enter assigns whatever is highlighted.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!targets?.length) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const index = targets.findIndex(target => target.id === selected);
      const next = event.key === 'ArrowDown'
        ? Math.min(index + 1, targets.length - 1)
        : Math.max(index - 1, 0);
      setSelected(targets[index === -1 ? 0 : next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [targets, selected]);

  const assign = async (target: string) => {
    setBusy(true);
    try {
      await grant(request.id, target);
      toast.success(`Assigned ${target}`, { description: request.reason });
      onAnswered();
    } catch (cause) {
      toast.error((cause as Error).message);
      setBusy(false);
    }
  };

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 overflow-hidden border-border/60 shadow-lg shadow-black/5 duration-500">
      <CardHeader className="gap-1">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono text-[11px]">
            {request.kind}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">{request.id}</span>
          <span className="text-xs text-muted-foreground">· {ageLabel(request.ageSeconds)}</span>
        </div>
        <p className="text-balance text-lg font-semibold leading-snug">{request.reason}</p>
      </CardHeader>

      <CardContent>
        {loading && !targets ? (
          <div className="space-y-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-4/5" />
          </div>
        ) : targets && targets.length > 0 ? (
          <ul className="-mx-1 space-y-0.5">
            {targets.map(target => (
              <TargetRow
                key={target.id}
                target={target}
                busy={busy}
                selected={selected === target.id}
                onSelect={() => setSelected(target.id)}
                onAssign={() => void assign(target.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            No {request.kind} can be assigned right now. Open one and refresh.
          </p>
        )}
      </CardContent>

      <CardFooter className="justify-between border-t border-border/60 !py-3">
        <p className="text-xs text-muted-foreground">
          Opened a {request.kind} just now? Refresh — the list is live.
        </p>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Refresh
          </Button>
          <DenyDialog
            reason={request.reason}
            onDeny={async note => {
              try {
                await deny(request.id, note);
                toast('Request denied');
                onAnswered();
              } catch (cause) {
                toast.error((cause as Error).message);
              }
            }}
          />
        </div>
      </CardFooter>
    </Card>
  );
}
