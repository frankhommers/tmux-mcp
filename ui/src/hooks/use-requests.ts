import { useCallback, useEffect, useRef, useState } from 'react';
import { listRequests, token, type PaneRequest } from '@/lib/api';

export type Connection = 'connecting' | 'live' | 'offline';

/**
 * Pending requests, kept fresh by the daemon's event stream. The stream only
 * says *that* something changed; the list itself is always re-read, so the
 * page cannot drift from the requests directory.
 */
export function useRequests() {
  const [requests, setRequests] = useState<PaneRequest[] | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const arrived = useRef<(reason: string) => void>(() => {});

  const refresh = useCallback(async () => {
    try {
      const { requests } = await listRequests();
      setRequests(requests);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();

    const events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
    events.addEventListener('open', () => setConnection('live'));
    events.addEventListener('error', () => setConnection('offline'));
    events.addEventListener('request-added', event => {
      void refresh();
      try {
        const data = JSON.parse((event as MessageEvent).data) as { reason: string };
        arrived.current(data.reason);
      } catch {
        // A malformed event is not worth breaking the page over.
      }
    });
    events.addEventListener('request-answered', () => void refresh());

    // The age labels tick without any server involvement.
    const timer = setInterval(() => {
      setRequests(current =>
        current?.map(request => ({
          ...request,
          ageSeconds: Math.round((Date.now() - request.createdAt) / 1000),
        })) ?? null
      );
    }, 1000);

    return () => {
      events.close();
      clearInterval(timer);
    };
  }, [refresh]);

  const onArrived = useCallback((handler: (reason: string) => void) => {
    arrived.current = handler;
  }, []);

  return { requests, connection, error, refresh, onArrived };
}
