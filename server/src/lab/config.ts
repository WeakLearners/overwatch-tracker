// Lab config (split plan B6). The Slack webhook and the tracker address belong
// to the lab, not to the tracker. Nothing under routes/ or db/ reads them.
// Today the lab still shares server/.env with the tracker; Stage 2 gives it
// its own env file. The variable names stay as they are so that move is a copy.
import dotenv from 'dotenv';
import path from 'path';

export interface LabConfig {
  /** Origin of the tracker whose /api/v1 the lab reads. */
  trackerUrl: string;
  /** Slack incoming webhook for the nightly report. Undefined when unset. */
  slackWebhookUrl: string | undefined;
}

export function loadLabConfig(env: NodeJS.ProcessEnv = process.env): LabConfig {
  if (env === process.env) dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  return {
    trackerUrl: env.LAB_TRACKER_URL || 'http://127.0.0.1:3001',
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || undefined,
  };
}
