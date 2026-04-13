import type { Page } from '@playwright/test';

/**
 * SSE event types matching use-agent-stream.ts
 */
export interface SSEEvent {
  type: string;
  agentName?: string;
  currentTask?: string;
  progress?: number;
  stats?: Record<string, number | string>;
  cost?: number;
  duration?: number;
  toolName?: string;
  args?: string;
}

/**
 * Injects a fake EventSource implementation into the page so tests can
 * programmatically push SSE events via `emitSSEEvent`.
 *
 * Must be called BEFORE `page.goto()`.
 */
export async function mockEventSource(page: Page) {
  await page.addInitScript(() => {
    // Store all fake EventSource instances so tests can dispatch events
    (window as any).__fakeEventSources = [] as any[];

    class FakeEventSource {
      url: string;
      readyState = 0; // CONNECTING
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;

      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;

      constructor(url: string) {
        this.url = url;
        (window as any).__fakeEventSources.push(this);

        // Simulate async connection open
        queueMicrotask(() => {
          this.readyState = 1; // OPEN
          if (this.onopen) {
            this.onopen(new Event('open'));
          }
        });
      }

      /** Called by tests via page.evaluate to push an event. */
      __pushEvent(data: string) {
        if (this.onmessage) {
          this.onmessage(new MessageEvent('message', { data }));
        }
      }

      close() {
        this.readyState = 2; // CLOSED
      }
    }

    // Replace the real EventSource
    (window as any).EventSource = FakeEventSource;
  });
}

/**
 * Pushes a single SSE event into the most recent fake EventSource instance.
 */
export async function emitSSEEvent(page: Page, event: SSEEvent) {
  await page.evaluate((data) => {
    const sources = (window as any).__fakeEventSources;
    if (sources && sources.length > 0) {
      const latest = sources[sources.length - 1];
      if (latest.readyState === 1) {
        latest.__pushEvent(data);
      } else {
        // Wait for open, then push
        const origOnOpen = latest.onopen;
        latest.onopen = (ev: Event) => {
          if (origOnOpen) origOnOpen(ev);
          latest.__pushEvent(data);
        };
      }
    }
  }, JSON.stringify(event));
}

/**
 * Pushes a sequence of SSE events with an optional delay between each.
 */
export async function emitSSESequence(
  page: Page,
  events: SSEEvent[],
  delayMs = 100,
) {
  for (const event of events) {
    await emitSSEEvent(page, event);
    if (delayMs > 0) {
      await page.waitForTimeout(delayMs);
    }
  }
}
