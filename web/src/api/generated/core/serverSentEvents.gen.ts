
import type { Config } from './types.gen.js';
export type ServerSentEventsOptions<TData = unknown> = Omit<RequestInit, 'method'> &
  Pick<Config, 'method' | 'responseTransformer' | 'responseValidator'> & {
    fetch?: typeof fetch;
    onRequest?: (url: string, init: RequestInit) => Promise<Request>;
    onSseError?: (error: unknown) => void;
    onSseEvent?: (event: StreamEvent<TData>) => void;
    serializedBody?: RequestInit['body'];
    sseDefaultRetryDelay?: number;
    sseMaxRetryAttempts?: number;
    sseMaxRetryDelay?: number;
    sseSleepFn?: (ms: number) => Promise<void>;
    url: string;
  };
export interface StreamEvent<TData = unknown> {
  data: TData;
  event?: string;
  id?: string;
  retry?: number;
}
export type ServerSentEventsResult<TData = unknown, TReturn = void, TNext = unknown> = {
  stream: AsyncGenerator<
    TData extends Record<string, unknown> ? TData[keyof TData] : TData,
    TReturn,
    TNext
  >;
};
export function createSseClient<TData = unknown>({
  onRequest,
  onSseError,
  onSseEvent,
  responseTransformer,
  responseValidator,
  sseDefaultRetryDelay,
  sseMaxRetryAttempts,
  sseMaxRetryDelay,
  sseSleepFn,
  url,
  ...options
}: ServerSentEventsOptions): ServerSentEventsResult<TData> {
  let lastEventId: string | undefined;
  const sleep = sseSleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const createStream = async function* () {
    let retryDelay: number = sseDefaultRetryDelay ?? 3000;
    let attempt = 0;
    const signal = options.signal ?? new AbortController().signal;
    while (true) {
      if (signal.aborted) break;
      attempt++;
      const headers =
        options.headers instanceof Headers
          ? options.headers
          : new Headers(options.headers as Record<string, string> | undefined);
      if (lastEventId !== undefined) {
        headers.set('Last-Event-ID', lastEventId);
      }
      try {
        const requestInit: RequestInit = {
          redirect: 'follow',
          ...options,
          body: options.serializedBody,
          headers,
          signal,
        };
        let request = new Request(url, requestInit);
        if (onRequest) {
          request = await onRequest(url, requestInit);
        }
        const _fetch = options.fetch ?? globalThis.fetch;
        const response = await _fetch(request);
        if (!response.ok) throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error('No body in SSE response');
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {
          }
        };
        signal.addEventListener('abort', abortHandler);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            buffer = buffer.replace(/\r\n?/g, '\n'); // normalize line endings
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() ?? '';
            for (const chunk of chunks) {
              const lines = chunk.split('\n');
              const dataLines: Array<string> = [];
              let eventName: string | undefined;
              for (const line of lines) {
                if (line.startsWith('data:')) {
                  dataLines.push(line.replace(/^data:\s*/, ''));
                } else if (line.startsWith('event:')) {
                  eventName = line.replace(/^event:\s*/, '');
                } else if (line.startsWith('id:')) {
                  lastEventId = line.replace(/^id:\s*/, '');
                } else if (line.startsWith('retry:')) {
                  const parsed = Number.parseInt(line.replace(/^retry:\s*/, ''), 10);
                  if (!Number.isNaN(parsed)) {
                    retryDelay = parsed;
                  }
                }
              }
              let data: unknown;
              let parsedJson = false;
              if (dataLines.length) {
                const rawData = dataLines.join('\n');
                try {
                  data = JSON.parse(rawData);
                  parsedJson = true;
                } catch {
                  data = rawData;
                }
              }
              if (parsedJson) {
                if (responseValidator) {
                  await responseValidator(data);
                }
                if (responseTransformer) {
                  data = await responseTransformer(data);
                }
              }
              onSseEvent?.({
                data,
                event: eventName,
                id: lastEventId,
                retry: retryDelay,
              });
              if (dataLines.length) {
                yield data as any;
              }
            }
          }
        } finally {
          signal.removeEventListener('abort', abortHandler);
          reader.releaseLock();
        }
        break; // exit loop on normal completion
      } catch (error) {
        onSseError?.(error);
        if (sseMaxRetryAttempts !== undefined && attempt >= sseMaxRetryAttempts) {
          break; // stop after firing error
        }
        const backoff = Math.min(retryDelay * 2 ** (attempt - 1), sseMaxRetryDelay ?? 30000);
        await sleep(backoff);
      }
    }
  };
  const stream = createStream();
  return { stream };
}
