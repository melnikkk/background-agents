import { setRun } from './agent-data';
import { inngest } from './inngest';

export const incidentAgent = inngest.createFunction(
  { id: 'incident-agent', name: 'Checkout incident agent', triggers: { event: 'incident/opened' } },
  async ({ event }) => {
    await setRun(event.data.runId, 'escalated', 'Harness not implemented yet');
    return { runId: event.data.runId };
  },
);
