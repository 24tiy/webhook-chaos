export interface OutgoingRequest {
  headers: Record<string, string>;
  body: Buffer;
}

export interface SignInput {
  body: Buffer;
  secret: string;
  webhookId: string;
  topic: string;
  eventTime: Date;
  signedAt: Date;
  recordedHeaders: Record<string, string>;
}

export interface Provider {
  readonly name: string;
  readonly anchorFields: readonly string[];
  readonly sensitiveKeys: readonly string[];
  readonly retryOffsetsMs: readonly number[];
  readonly signatureHeader: string;
  readonly carriedHeaders: readonly string[];
  topicOf(headers: Record<string, string>): string | null;
  webhookIdOf(headers: Record<string, string>): string | null;
  build(input: SignInput): OutgoingRequest;
}
