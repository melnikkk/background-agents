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
import { ActionName } from '../shared/types';
import { logAgentActivity } from './agent-log';
import { ACTION_TO_POLICY_MAP } from './tool-policy';

async function executeAction(
  environmentId: string,
  runId: string,
  actionId: string,
  name: ActionName,
  expectedVersion?: number,
) {
  const input = expectedVersion === undefined ? {} : { expectedVersion };

  await logAgentActivity(environmentId, runId, 'act', `Calling ${name}`, {
    actionId,
    input,
  });

  try {
    const response = await fetch(`${checkoutServiceUrl}/operations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actionId,
        name,
        ...input,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(String(result.error ?? response.status));
    }

    if (result.stale !== true) {
      await recordToolAction(environmentId, runId, actionId, name, input, result);
    }

    return result;
  } catch (error) {
    await logAgentActivity(environmentId, runId, 'act', `Error calling ${name}`, {
      actionId,
      error: String(error),
    });
    throw error;
  }
}

const TERMINAL_STATUSES = ['completed', 'failed', 'escalated', 'cancelled', 'superseded'];

export const incidentAgent = inngest.createFunction(
  { id: 'incident-agent', name: 'Checkout incident agent', triggers: { event: 'incident/opened' } },
  async ({ event, step }) => {
    const { environmentId, runId, instanceId } = event.data;

    const run = await getRun(runId);

    if (run.instanceId !== instanceId || TERMINAL_STATUSES.includes(run.status)) {
      return;
    }

    for (let cycle = 1; cycle <= 24; cycle++) {
      const currentRun = await getRun(runId);

      if (TERMINAL_STATUSES.includes(currentRun.status)) {
        return;
      }

      const state = await step.run(`observe-state-${cycle}`, () =>
        getAgentState(environmentId, runId),
      );

      if (isGoalSatisfied(state, run.goalCondition)) {
        const report = await step.run(`write-report-${cycle}`, () => writeReport(run.goal, state));

        await step.run(`complete-run-${cycle}`, () => setRun(runId, 'completed', null, report));

        return { report };
      }

      const decision = await step.run(`choose-action-${cycle}`, () =>
        chooseAction(run.goal, state),
      );

      await step.run(`set-iteration-${cycle}`, () => setIteration(runId, cycle));
      await step.run(`record-decision-${cycle}`, () =>
        recordDecision(environmentId, runId, cycle, decision.action, decision.reason),
      );

      if (['wait', 'complete'].includes(decision.action) && run.goalCondition) {
        await step.run(`wait-unavailable-${cycle}`, () =>
          setRun(runId, 'escalated', 'Event wait is not built yet'),
        );

        return;
      }

      if (decision.action === 'complete') {
        const report = await step.run(`write-report-${cycle}`, () => writeReport(run.goal, state));

        await step.run(`complete-run-${cycle}`, () => setRun(runId, 'completed', null, report));

        return { report };
      }

      if (decision.action === 'request_help') {
        await step.run(`help-unavailable-${cycle}`, () =>
          setRun(runId, 'escalated', 'Human help is not created yet'),
        );

        return;
      }

      const actionId = await step.run(`action-id-${cycle}`, () => `${runId}:${randomUUID()}`);
      const policy = ACTION_TO_POLICY_MAP[decision.action];

      if (policy === 'approval') {
        await step.run(`approval-unavailable-${cycle}`, () =>
          setRun(runId, 'escalated', 'Approval is not built yet'),
        );

        return;
      }

      const result = await step.run(`execute-action-${cycle}`, () =>
        executeAction(
          environmentId,
          runId,
          actionId,
          decision.action,
          policy === 'read' ? undefined : state.world.version,
        ),
      );

      if (result.stale === true) {
        await step.run(`stale-action-${cycle}`, () =>
          logAgentActivity(
            environmentId,
            runId,
            'act',
            'Action rejected due to stale world version',
            result,
          ),
        );

        continue;
      }
    }

    await step.run('decision-limit-reached', () =>
      setRun(runId, 'escalated', 'Decision limit reached'),
    );
  },
);
