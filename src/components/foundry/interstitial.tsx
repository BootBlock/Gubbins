/**
 * The centred "this screen isn't available" notice — the shell every route interstitial shares.
 *
 * Two screens now stand in for a route rather than rendering it: the Modular UI's "module hidden"
 * page, and the read-permission refusal (issue #522). They are the same object — a centred card
 * carrying a round icon medallion, a heading, an explanation and a way forward — and were the same
 * markup twice, down to the medallion's class list. One copy is a component; two is a primitive
 * that has not been written yet.
 *
 * It owns the `<main id={MAIN_CONTENT_ID}>` landmark the skip link targets, so a caller composes
 * `PageContainer` + `PageHeader` around it and nothing else. Every value here is a design token;
 * the caller supplies content, never styling.
 */
import type { ReactNode } from 'react';
import { MAIN_CONTENT_ID } from './skip-link';
import { Surface } from './surface';

export interface InterstitialProps {
  /** The medallion glyph. Rendered decoratively — the heading carries the meaning. */
  readonly icon: ReactNode;
  /** The one-line statement of what has happened. */
  readonly heading: string;
  /** Explanatory paragraphs, in order. Each renders as its own muted line. */
  readonly body: readonly string[];
  /** The ways forward — buttons and links, laid out in a centred wrapping row. */
  readonly actions?: ReactNode;
  /** Anything below the actions, such as a quieter secondary link. */
  readonly footer?: ReactNode;
}

/** A centred notice standing in for a screen the app is not going to render. */
export function Interstitial({ icon, heading, body, actions, footer }: InterstitialProps) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      className="flex flex-1 animate-rise flex-col items-center justify-center py-10 outline-none"
    >
      <Surface className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground [&_svg]:size-6"
        >
          {icon}
        </span>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold text-foreground">{heading}</h2>
          {body.map((line) => (
            <p key={line} className="text-sm text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
        {actions ? <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
        {footer}
      </Surface>
    </main>
  );
}
