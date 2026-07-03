import { useState } from 'react';
import { Banner } from '@/components/foundry';
import { ExternalLinkIcon, InfoIcon, SettingsIcon, TerminalIcon, VoiceIcon } from '@/components/icons';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';
import { useGuide, tokenForDisplay } from '../context';
import { GuideLink } from '../links';

type Wiring = 'file' | 'automation';

/**
 * Step 7 — wire the phrases into Assist, and (if needed) bridge a Google speaker.
 *
 * Two things have to happen: Assist must *recognise* your phrases and know how to *answer*
 * them. How that's wired depends on the install, so this branches:
 *  - the ready-made **sentences file** (pairs with the custom integration's intent), or
 *  - a **conversation automation** that matches the phrases and calls the bridge itself —
 *    all in the UI, no file editing, works with any install.
 *
 * It also covers the extra hop a **Google Home / Nest** speaker needs (a Routine that says
 * "Talk to Home Assistant"), which the built-in Assist path doesn't — this is the piece a
 * real-world Google-speaker setup can't do without.
 */
export function SentencesStep() {
  const { token } = useGuide();
  const displayToken = tokenForDisplay(token);
  const [wiring, setWiring] = useState<Wiring | null>(null);

  return (
    <div className="space-y-6">
      <StepCard title="Teach Assist to recognise your phrases" icon={<VoiceIcon />}>
        <p className="text-sm text-muted-foreground">
          Home Assistant's <span className="text-foreground">Assist</span> agent has to map what you say (like{' '}
          <span className="text-foreground">"where are my M3 screws?"</span>) to an action, and then speak the
          answer. There are two ways to wire that up — pick the one that matches how you installed things.
        </p>
      </StepCard>

      <ChoiceCards
        legend="How do you want to set up the phrases?"
        value={wiring}
        onChange={setWiring}
        options={[
          {
            id: 'file',
            title: 'Ready-made sentences file',
            description: 'Pairs with the custom integration. A file copy + restart.',
            Icon: VoiceIcon,
          },
          {
            id: 'automation',
            title: 'A conversation automation',
            description: 'All in the UI, no file editing. Works with any install.',
            Icon: SettingsIcon,
          },
        ]}
      />

      {wiring === 'file' ? (
        <BranchPanel>
          <StepCard title="Copy the sentences file">
            <p className="text-sm text-muted-foreground">
              The <span className="text-foreground">custom integration</span> already knows how to answer (its
              <code className="ml-1 rounded bg-secondary/60 px-1">GubbinsWhereIs</code> intent). You just
              teach Assist the phrases by copying the bundled file into your config, keeping the same
              sub-path:
            </p>
            <CommandBlock
              label="sentences file destination"
              code={`homeassistant/custom_sentences/en/gubbins.yaml\n        ↓ copy to\n<config>/custom_sentences/en/gubbins.yaml`}
            />
            <p className="text-sm text-muted-foreground">
              Then <span className="text-foreground">restart Home Assistant</span> so it loads the new
              sentences.
            </p>
            <Banner tone="info" icon={<InfoIcon />} heading="You can add your own phrasings">
              That file is plain YAML. The <code className="rounded bg-secondary/60 px-1">{'{item}'}</code>{' '}
              placeholder is a wildcard, so anything you say after it is sent to the bridge. Add regional
              turns of phrase to taste, then restart again.
            </Banner>
            <p className="text-sm text-muted-foreground">
              No text editor inside Home Assistant? The easiest are the{' '}
              <span className="text-foreground">File editor</span> or{' '}
              <span className="text-foreground">Studio Code Server</span> add-ons from the Add-on store (Core
              users can edit over SSH). Or use the conversation-automation option above, which needs no file
              editing at all.
            </p>
          </StepCard>
        </BranchPanel>
      ) : wiring === 'automation' ? (
        <BranchPanel>
          <StepCard title="Create a conversation automation" icon={<TerminalIcon />}>
            <p className="text-sm text-muted-foreground">
              This route needs no custom component and no files — it both recognises the phrases and calls the
              bridge. It's ideal if you used the no-code path, or just prefer to stay in the UI.
            </p>
            <p className="text-sm text-muted-foreground">
              First add a command that calls the bridge. A{' '}
              <code className="rounded bg-secondary/60 px-1">shell_command</code> with{' '}
              <code className="rounded bg-secondary/60 px-1">curl</code> is the most robust — it sidesteps a
              known quirk where Home Assistant's{' '}
              <code className="rounded bg-secondary/60 px-1">rest_command</code> can mangle a URL that has a
              custom port and a template together. Put this in{' '}
              <code className="rounded bg-secondary/60 px-1">configuration.yaml</code> (adjust the host if the
              bridge isn't local):
            </p>
            <CommandBlock
              label="shell_command snippet"
              caption="configuration.yaml"
              code={shellCommandSnippet(displayToken)}
            />
            <p className="text-sm text-muted-foreground">
              Then add the automation. Go to{' '}
              <span className="text-foreground">
                Settings → Automations &amp; scenes → Create automation → Create new automation
              </span>
              , open the ⋮ menu, choose <span className="text-foreground">Edit in YAML</span>, and paste this
              (then Save):
            </p>
            <CommandBlock label="conversation automation YAML" code={CONVERSATION_AUTOMATION} />
            <Banner tone="info" icon={<InfoIcon />} heading="No grammar script needed">
              The bridge's <code className="rounded bg-secondary/60 px-1">/where</code> endpoint already
              returns a ready-to-speak sentence (<code className="rounded bg-secondary/60 px-1">spoken</code>
              ), handling plurals and "in transit"/"unassigned" for you — so the automation just reads that.
              Older guides that build a big pronoun/plural template by hand are no longer necessary.
            </Banner>
            <p className="text-sm text-muted-foreground">
              After saving, <span className="text-foreground">reload automations</span> (or restart HA).
            </p>
          </StepCard>
        </BranchPanel>
      ) : null}

      <StepCard title="Using a Google Home or Nest speaker?" icon={<VoiceIcon />}>
        <p className="text-sm text-muted-foreground">
          Talking to Home Assistant's Assist directly (the HA app, a Voice Preview Edition, or a wake-word
          device) needs nothing extra. But{' '}
          <span className="text-foreground">Google Assistant won't pass free-form words</span> (like "nails")
          straight to a third-party skill — so with a Google speaker you bridge to Home Assistant first with a
          Google Home Routine, then ask your question inside the HA conversation.
        </p>
        <ol className="ml-4 list-decimal space-y-2 text-sm text-muted-foreground">
          <li>
            In the <span className="text-foreground">Google Home app</span>, go to{' '}
            <span className="text-foreground">Automations</span> and add a new Routine.
          </li>
          <li>
            Add a starter <span className="text-foreground">"When I say to Google Assistant"</span> and type a
            phrase such as <span className="text-foreground">Check location</span>.
          </li>
          <li>
            Add an action that opens Home Assistant — e.g.{' '}
            <span className="text-foreground">"Talk to Home Assistant"</span> — and save.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">Then it's a two-beat conversation:</p>
        <ul className="ml-1 space-y-1.5 text-sm">
          <li className="text-foreground">
            "Hey Google, check location."{' '}
            <span className="text-muted-foreground">(hands you to Home Assistant)</span>
          </li>
          <li className="text-foreground">
            "Where did I put the nails?"{' '}
            <span className="text-muted-foreground">(Home Assistant answers from Gubbins)</span>
          </li>
        </ul>
        <Banner tone="info" icon={<InfoIcon />}>
          "Talk to Home Assistant" requires Home Assistant to be linked to Google Assistant (via Nabu Casa
          Home Assistant Cloud, or the manual Google Assistant integration). The Gubbins phrases still come
          from the wiring you chose above — the Routine only opens the door to Assist.
        </Banner>
      </StepCard>

      <StepCard title="More detail">
        <p className="text-sm text-muted-foreground">
          The exact sentences file, more phrasing examples, and the full YAML recipes are in the{' '}
          <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/homeassistant/README.md">
            Home Assistant README <ExternalLinkIcon />
          </GuideLink>
          .
        </p>
      </StepCard>
    </div>
  );
}

/** The robust `shell_command` that curls the bridge's `/where`, with the token filled in. */
function shellCommandSnippet(token: string): string {
  return [
    'shell_command:',
    '  gubbins_where_is: >',
    `    curl -s -H "Authorization: Bearer ${token}"`,
    '    "http://127.0.0.1:8787/where?q={{ item | urlencode }}"',
  ].join('\n');
}

/**
 * A conversation-trigger automation that recognises the phrases and speaks the bridge's ready-made
 * sentence. Uses the bridge's `spoken` field (no hand-rolled grammar), and safely defaults if the
 * bridge is unreachable.
 */
const CONVERSATION_AUTOMATION = `- id: "gubbins_voice_inventory_search"
  alias: "Gubbins Voice Inventory Search"
  mode: single
  trigger:
    - platform: conversation
      command:
        - "where is [the] {item}"
        - "where are [the] {item}"
        - "where is my {item}"
        - "where are my {item}"
        - "where's [the] {item}"
        - "find [the] {item}"
        - "find my {item}"
        - "where did I put [the] {item}"
        - "where did I leave [the] {item}"
        - "locate [the] {item}"
  action:
    - service: shell_command.gubbins_where_is
      data:
        item: "{{ trigger.slots.item | trim }}"
      response_variable: cmd
    - variables:
        data: "{{ cmd.stdout | default('{}', true) | from_json }}"
    - set_conversation_response: >
        {% if data.spoken is defined %}
          {{ data.spoken }}
        {% else %}
          Sorry, I couldn't reach the Gubbins inventory bridge just now.
        {% endif %}`;
