import { ArrowRight, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseLabel, type Target } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  target: Target;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onAssign: () => void;
}

export function TargetRow({ target, busy, selected, onSelect, onAssign }: Props) {
  const { id, location, command, title } = parseLabel(target.label);

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Assign ${id}`}
        onFocus={onSelect}
        onMouseEnter={onSelect}
        onClick={onAssign}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onAssign();
          }
        }}
        className={cn(
          'group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5',
          'cursor-pointer transition-colors outline-none',
          'hover:border-border hover:bg-accent/60',
          'focus-visible:border-ring focus-visible:bg-accent/60',
          selected && 'border-border bg-accent/60',
          busy && 'pointer-events-none opacity-50'
        )}
      >
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />

        <span className="font-mono text-sm font-medium tabular-nums">{id}</span>

        {command && (
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {command}
          </span>
        )}

        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {location}
          {title && <span className="ml-2 opacity-70">{title}</span>}
        </span>

        <Button
          size="sm"
          tabIndex={-1}
          onClick={event => {
            event.stopPropagation();
            onAssign();
          }}
          className={cn(
            'shrink-0 opacity-0 transition-opacity',
            'group-hover:opacity-100 group-focus-visible:opacity-100',
            selected && 'opacity-100'
          )}
        >
          Assign
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}
