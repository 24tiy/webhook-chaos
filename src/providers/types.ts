export interface OutgoingRequest {
  headers: Record<string, string>;
  body: Buffer;
}

export interface PreparePayloadInput {
  payload: unknown;
  anchor: string | null;
  eventTime: Date;
  webhookId: string;
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
  readonly sensitiveKeys: readonly string[];
  readonly retryOffsetsMs: readonly number[];
  readonly signatureHeader: string;
  readonly carriedHeaders: readonly string[];
  anchorOf(payload: unknown): string | null;
  topicOf(headers: Record<string, string>, payload: unknown): string | null;
  preparePayload(input: PreparePayloadInput): unknown;
  build(input: SignInput): OutgoingRequest;
}
