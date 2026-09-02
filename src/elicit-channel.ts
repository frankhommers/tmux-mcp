import type { Answer, PaneRequest } from './requests.js';

/**
 * The slice of the MCP Server class this channel needs. Declared structurally
 * so tests can pass a fake without constructing a real server.
 */
export interface ElicitEnumField {
  type: 'string';
  title?: string;
  description?: string;
  enum: string[];
  enumNames?: string[];
}

export interface ElicitTextField {
  type: 'string';
  title?: string;
  description?: string;
  maxLength?: number;
}

export type ElicitField = ElicitEnumField | ElicitTextField;

export interface ElicitCapableServer {
  getClientCapabilities(): { elicitation?: unknown } | undefined;
  elicitInput(
    params: {
      message: string;
      requestedSchema: {
        type: 'object';
        properties: { [key: string]: ElicitField };
        required?: string[];
      };
    },
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/** Matches the request expiry, so the prompt outlives the tool call. */
const ELICITATION_TIMEOUT_MS = 30 * 60 * 1000;

/** Dropdown choice for a target that did not exist when the agent asked. */
const OTHER = 'other';

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
    message: `The agent is asking for a tmux ${noun}.\n\nReason: ${request.reason}\n\nPick the ${noun} it may use, or choose "deny". The list was taken when the agent asked — if you have opened a ${noun} since then, choose "other" and type its id.`,
    requestedSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string' as const,
          title: `tmux ${noun}`,
          description: `The ${noun} the agent may use.`,
          enum: [...request.candidates.map(c => c.id), OTHER, 'deny'],
          enumNames: [
            ...request.candidates.map(c => c.label),
            `Other — type an id below (for a ${noun} opened just now)`,
            'Deny this request',
          ],
        },
        otherTarget: {
          type: 'string' as const,
          title: `Other ${noun} id`,
          description: `Only used when "other" is selected above. A ${noun} id such as ${request.kind === 'pane' ? '%7' : '@3'}.`,
          maxLength: 32,
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
      const choice = result.content?.target;
      if (choice === 'deny') {
        onAnswer({ status: 'denied', reason: undefined, via: 'elicitation' });
        return;
      }
      // The chosen id is validated against live tmux state by answerRequest(),
      // so a target typed into "other" is as acceptable as one from the list.
      const typed = result.content?.otherTarget;
      const target = choice === OTHER ? typed : choice;
      if (typeof target === 'string' && target.trim().length > 0) {
        onAnswer({ status: 'granted', target: target.trim(), via: 'elicitation' });
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
