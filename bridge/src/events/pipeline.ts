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
  /**
   * Hand a generation's events to this sink. Must not throw; must return promptly.
   *
   * `driver` is the just-swapped generation's driver, passed so a sink that needs to *read* while
   * projecting an event can do so — the webhook deliverer resolves each event's location path,
   * category and tags this way (`webhook-view.ts`). It is optional because most sinks (SSE, MQTT)
   * serialise the envelope and need nothing else, and because the read-triggered `lookup.resolved`
   * path has no generation behind it.
   *
   * A sink may return a promise; the pipeline **awaits** it. That is what keeps a reading sink
   * safe: the watcher does not let the next reload close the driver until `onGeneration` resolves,
   * so awaiting here is the difference between reading a live driver and racing a closed one. Work
   * that needs no driver (the actual HTTP delivery) should be queued rather than awaited, so a slow
   * receiver cannot hold up the next hydration.
   */
  deliver(events: readonly BridgeEvent[], driver?: IDatabaseDriver): void | Promise<void>;
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
            // Awaited so a sink that reads the driver while projecting events (the webhook
            // deliverer) finishes before the watcher is free to close it. A sink returning void
            // costs nothing here.
            await sink.deliver(events, driver);
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
