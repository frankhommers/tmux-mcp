import type { Answer, PaneRequest } from './requests.js';

/**
 * The slice of the MCP Server class this channel needs. Declared structurally
 * so tests can pass a fake without constructing a real server.
 */
export interface ElicitCapableServer {
  getClientCapabilities(): { elicitation?: unknown } | undefined;
  elicitInput(
    params: {
      message: string;
      requestedSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      };
    },
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/** Matches the request expiry, so the prompt outlives the tool call. */
const ELICITATION_TIMEOUT_MS = 30 * 60 * 1000;

export function clientSupportsElicitation(server: ElicitCapableServer): boolean {
  return server.getClientCapabilities()?.elicitation !== undefined;
}

/**
 * Ask the human through the MCP client. The prompt stays open after the
 * tool call returns `pending`; abort it when another channel answers first.
 */
export function startElicitation(
  server: ElicitCapableServer,
  request: PaneRequest,
  onAnswer: (answer: Answer) => void,
  log: (level: 'info' | 'warning', message: string) => void
): () => void {
  const controller = new AbortController();
  const noun = request.kind === 'pane' ? 'pane' : 'window';

  const params = {
    message: `The agent is asking for a tmux ${noun}.\n\nReason: ${request.reason}\n\nPick the ${noun} it may use, or choose "deny".`,
    requestedSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          title: `tmux ${noun}`,
          description: `The ${noun} the agent may use.`,
          enum: [...request.candidates.map(c => c.id), 'deny'],
          enumNames: [...request.candidates.map(c => c.label), 'Deny this request'],
        },
      },
      required: ['target'],
    },
  };

  void server.elicitInput(params, { timeout: ELICITATION_TIMEOUT_MS, signal: controller.signal })
    .then(result => {
      if (controller.signal.aborted) return;
      if (result.action === 'decline') {
        onAnswer({ status: 'denied', reason: undefined, via: 'elicitation' });
        return;
      }
      if (result.action !== 'accept') return; // 'cancel': leave it to other channels
      const target = result.content?.target;
      if (target === 'deny') {
        onAnswer({ status: 'denied', reason: undefined, via: 'elicitation' });
        return;
      }
      if (typeof target === 'string' && request.candidates.some(c => c.id === target)) {
        onAnswer({ status: 'granted', target, via: 'elicitation' });
        return;
      }
      log('warning', `elicitation for ${request.id} returned an unusable target`);
    })
    .catch(error => {
      if (controller.signal.aborted) return;
      log('warning', `elicitation for ${request.id} failed: ${(error as Error).message}`);
    });

  return () => controller.abort();
}
