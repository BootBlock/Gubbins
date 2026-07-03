import { useEffect, useRef, useState } from 'react';
import { Button, PageContainer, PageHeader, buttonVariants, MAIN_CONTENT_ID } from '@/components/foundry';
import { ChevronLeftIcon, ChevronRightIcon, ExtensionIcon, ExternalLinkIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { GuideProvider } from './context';
import {
  FIRST_STEP_ID,
  GUIDE_STEPS,
  indexOfStep,
  nextStepId,
  prevStepId,
  progressFor,
  type GuideStepId,
} from './guide';
import { StepRail } from './StepRail';
import { STEP_COMPONENTS } from './steps';

/**
 * The Home Assistant setup guide (lazily loaded, seldom-used screen).
 *
 * An interactive, step-by-step walkthrough for linking a local Gubbins bridge to Home
 * Assistant's voice assistant. It hand-holds the user through a linear backbone of steps, each
 * of which branches on the choices they make and the outcomes they see, and it can mint the
 * bridge access token in-browser so a user without a terminal isn't blocked.
 *
 * The whole feature lives behind a route, so with the router's automatic code-splitting none of
 * it is loaded until the user actually opens the guide.
 */
export function HomeAssistantSetupScreen() {
  const [stepId, setStepId] = useState<GuideStepId>(FIRST_STEP_ID);
  const [token, setToken] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const step = GUIDE_STEPS[indexOfStep(stepId)]!;
  const StepBody = STEP_COMPONENTS[stepId];
  const progress = progressFor(stepId);
  const next = nextStepId(stepId);
  const prev = prevStepId(stepId);

  // On step change, move focus to the new step heading and scroll it into view so keyboard and
  // screen-reader users land at the top of the new content (and sighted users aren't left
  // scrolled halfway down the previous step).
  useEffect(() => {
    headingRef.current?.focus();
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [stepId]);

  return (
    <GuideProvider value={{ token, setToken }}>
      <PageContainer>
        <PageHeader
          icon={<ExtensionIcon />}
          title="Home Assistant setup"
          actions={
            <a
              href="https://github.com/BootBlock/Gubbins/blob/main/homeassistant/README.md"
              target="_blank"
              rel="noreferrer noopener"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <ExternalLinkIcon />
              Full docs
            </a>
          }
        />

        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 flex-col gap-6 outline-none">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Link this inventory to Home Assistant's voice assistant so you can ask where your things are. Work
            through the steps below — each one adapts to the choices you make, and you can jump around freely
            if you've done some already.
          </p>

          <StepRail currentId={stepId} onSelect={setStepId} />

          <section className="animate-rise space-y-6" aria-labelledby="ha-step-heading">
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-primary">
                Step {progress.current} of {progress.total}
              </p>
              <h2
                id="ha-step-heading"
                ref={headingRef}
                tabIndex={-1}
                className="flex items-center gap-2 text-xl font-semibold tracking-tight outline-none [&_svg]:size-5"
              >
                <step.Icon aria-hidden className="text-primary" />
                {step.label}
              </h2>
              <p className="text-sm text-muted-foreground">{step.summary}</p>
            </div>

            <StepBody />

            <div className="flex items-center justify-between gap-3 border-t border-border pt-6">
              <Button
                variant="outline"
                onClick={() => prev && setStepId(prev)}
                disabled={!prev}
                data-testid="guide-prev"
              >
                <ChevronLeftIcon />
                Back
              </Button>
              {next ? (
                <Button onClick={() => setStepId(next)} data-testid="guide-next">
                  Next: {GUIDE_STEPS[indexOfStep(next)]!.label}
                  <ChevronRightIcon />
                </Button>
              ) : (
                <span className="text-sm font-medium text-glyph-success" data-testid="guide-complete">
                  That's everything — enjoy your voice inventory!
                </span>
              )}
            </div>
          </section>
        </main>
      </PageContainer>
    </GuideProvider>
  );
}
