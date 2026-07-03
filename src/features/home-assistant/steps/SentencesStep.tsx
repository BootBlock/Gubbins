import { Banner } from '@/components/foundry';
import { ExternalLinkIcon, InfoIcon, VoiceIcon } from '@/components/icons';
import { CommandBlock, StepCard } from '../components';
import { GuideLink } from '../links';

/**
 * Step 7 — wire the voice sentences into Assist.
 *
 * Home Assistant's Assist agent needs to know which spoken phrases map to the Gubbins intent.
 * This is the same for every install route (custom integration or YAML): copy the bundled
 * sentences file into the config, restart, done. Kept deliberately short and prescriptive.
 */
export function SentencesStep() {
  return (
    <div className="space-y-6">
      <StepCard title="Teach Assist the phrases" icon={<VoiceIcon />}>
        <p className="text-sm text-muted-foreground">
          Home Assistant's built-in <span className="text-foreground">Assist</span> agent maps what you say to
          an "intent". Gubbins ships a ready-made sentences file listing phrasings like{' '}
          <span className="text-foreground">"where are my …"</span>,{' '}
          <span className="text-foreground">"find my …"</span> and{' '}
          <span className="text-foreground">"how many … do I have"</span>. You copy it into your config once.
        </p>
      </StepCard>

      <StepCard title="Copy the sentences file">
        <p className="text-sm text-muted-foreground">
          Copy the bundled file from the repository into your Home Assistant config directory, keeping the
          same sub-path:
        </p>
        <CommandBlock
          label="sentences file destination"
          code={`homeassistant/custom_sentences/en/gubbins.yaml\n        ↓ copy to\n<config>/custom_sentences/en/gubbins.yaml`}
        />
        <p className="text-sm text-muted-foreground">
          Then <span className="text-foreground">restart Home Assistant</span> so it loads the new sentences.
        </p>
        <Banner tone="info" icon={<InfoIcon />} heading="You can add your own phrasings">
          That file is plain YAML. The <code className="rounded bg-secondary/60 px-1">{'{item}'}</code>{' '}
          placeholder is a wildcard, so anything you say after it is sent to the bridge. Add regional turns of
          phrase to taste, then restart again.
        </Banner>
      </StepCard>

      <StepCard title="No File editor add-on?">
        <p className="text-sm text-muted-foreground">
          To create files inside Home Assistant, the easiest tools are the{' '}
          <span className="text-foreground">File editor</span> or{' '}
          <span className="text-foreground">Studio Code Server</span> add-ons from the Add-on store. Advanced
          users on Home Assistant Core can edit over SSH instead. The exact sentences file and more phrasing
          examples are in the{' '}
          <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/homeassistant/README.md">
            Home Assistant README <ExternalLinkIcon />
          </GuideLink>
          .
        </p>
      </StepCard>
    </div>
  );
}
