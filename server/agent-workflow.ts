import { inngest } from './inngest';
import {
  getAgentState,
  getRun,
  isGoalSatisfied,
  recordDecision,
  recordToolAction,
  setIteration,
  setRun,
} from './agent-data';
import { chooseAction, writeReport } from './agent-brain';
import { randomUUID } from 'node:crypto';
import { checkoutServiceUrl } from './observe';

export const incidentAgent = inngest.createFunction(
  { id: 'incident-agent', name: 'Checkout incident agent', triggers: { event: 'incident/opened' } },
  async ({ event, step }) => {
    const { environmentId, runId } = event.data;

    return step.run('whole-agent-loop', async () => {
      const run = await getRun(runId);

      for (let cycle = 1; cycle <= 8; cycle++) {
        const state = await getAgentState(environmentId, runId);

        if (isGoalSatisfied(state, run.goalCondition)) {
          const report = await writeReport(run.goal, state);

          await setRun(runId, 'completed', report);

          return { report };
        }

        const decision = await chooseAction(run.goal, state);

        await setIteration(runId, cycle);
        await recordDecision(environmentId, runId, cycle, decision.action, decision.reason);

        if (['wait', 'complete', 'request_help'].includes(decision.action)) {
          await setRun(runId, 'escalated', 'This first loop can not pause yet');

          return;
        }

        if (decision.action === 'rollback_release') {
          await setRun(runId, 'escalated', 'Approval not build yet');

          return;
        }

        const actionId = `${runId}:${randomUUID()}`;
        const response = await fetch(checkoutServiceUrl + '/operations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            actionId,
            name: decision.action,
            expectedVersion: state.world.version,
          }),
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(String(result.error ?? response.status));
        }

        if (result.stale !== true) {
          await recordToolAction(
            environmentId,
            runId,
            actionId,
            decision.action,
            {
              expectedVersion: state.world.version,
            },
            result,
          );
        }
      }

      await setRun(runId, 'escalated', 'Decision limit reached');
    });
  },
);
