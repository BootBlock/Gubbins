/**
 * Event pipeline (EI-1) — the post-swap fan-out that turns each hydration generation into a
 * delivery to every registered sink.
 *
 * The watcher calls {@link EventPipeline.onGeneration} after each atomic driver swap. The
 * pipeline holds the resumption cursor across generations, computes the new events through
 * {@link computeGenerationEvents}, and hands them to each sink. It is defensive by design:
 * a sink or a read that throws is logged and swallowed, so an event-delivery fault can never
 * tear down the watcher or the HTTP server (the bridge's data-serving job is unaffected).
 *
 * Because the watcher awaits `onGeneration` before it lets the next reload close the driver
 * (see `watcher.ts`), a generation's reads always run against a live driver — no
 * closed-driver race.
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { computeGenerationEvents, type GenerationOptions } from './generation.ts';
import type { BridgeEvent, EventCursor } from './model.ts';

/** A destination for delivered events (a webhook queue, the SSE hub, …). */
export interface EventSink {
  /** Hand a generation's events to this sink. Must not throw; must return promptly. */
  deliver(events: readonly BridgeEvent[]): void;
}

export interface EventPipelineOptions extends GenerationOptions {
  readonly sinks: readonly EventSink[];
  /** Optional error reporter for a failed generation (defaults to `console.error`). */
  readonly onError?: (error: Error) => void;
}

export interface EventPipeline {
  /** Compute and fan out the events for the just-swapped driver. Never rejects. */
  onGeneration(driver: IDatabaseDriver): Promise<void>;
}

/** Create the stateful event pipeline that fans each generation to `sinks`. */
export function createEventPipeline(options: EventPipelineOptions): EventPipeline {
  let cursor: EventCursor | null = null;

  return {
    async onGeneration(driver: IDatabaseDriver): Promise<void> {
      try {
        const { events, cursor: next } = await computeGenerationEvents(driver, cursor, options);
        cursor = next;
        if (events.length === 0) return;
        for (const sink of options.sinks) {
          try {
            sink.deliver(events);
          } catch (err) {
            report(options, err);
          }
        }
      } catch (err) {
        report(options, err);
      }
    },
  };
}

function report(options: EventPipelineOptions, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  if (options.onError) options.onError(error);
  else console.error(`Event pipeline error: ${error.message}`);
}
