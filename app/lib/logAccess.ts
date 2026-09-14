import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const REGION = process.env.AWS_REGION;
const TOPIC_ARN = process.env.SNS_TOPIC_ARN;

const snsClient = REGION ? new SNSClient({ region: REGION }) : undefined;

export type AccessLogEvent = {
  // Showcase identifier the token maps to (e.g. "PRUDENTIAL"), or
  // "UNAUTHORIZED" when the request failed auth. Never the raw token.
  identifier: string;
  endpoint: string;
  method: string;
  status: number;
  albumId?: string;
  videoId?: string;
  query?: Record<string, string>;
  ip?: string;
};

// Fire-and-forget publish to SNS. Never throws — a logging failure must
// not affect the actual proxy response.
export function logAccess(event: AccessLogEvent) {
  if (!snsClient || !TOPIC_ARN) {
    console.warn("logAccess: AWS_REGION or SNS_TOPIC_ARN not set, skipping SNS publish", event);
    return;
  }

  const payload = { timestamp: new Date().toISOString(), ...event };

  snsClient
    .send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: `Vimeo proxy access: ${event.identifier}`.slice(0, 100),
        Message: JSON.stringify(payload, null, 2),
      })
    )
    .catch((err) => {
      console.error("logAccess: failed to publish to SNS", err);
    });
}
