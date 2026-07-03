import { useState } from 'react';
import { Banner } from '@/components/foundry';
import { CelebrateIcon, ExternalLinkIcon, InfoIcon, VoiceIcon } from '@/components/icons';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';
import { useGuide, tokenForDisplay } from '../context';
import { GuideLink } from '../links';

type Trouble = 'not-found' | 'unreachable' | 'nothing' | null;

/**
 * Step 8 — try it, and troubleshoot.
 *
 * Celebrates the finish, gives concrete phrases to try, and offers a small symptom-driven
 * troubleshooter for the three failures a user is most likely to hit at the voice layer.
 */
export function FinishStep() {
  const { token } = useGuide();
  const displayToken = tokenForDisplay(token);
  const [trouble, setTrouble] = useState<Trouble>(null);

  return (
    <div className="space-y-6">
      <StepCard title="You're done — ask it something" icon={<CelebrateIcon />}>
        <Banner tone="success" icon={<CelebrateIcon />} heading="Your voice inventory is live">
          Open{' '}
          <span className="text-foreground">Settings → Voice assistants → (your assistant) → Try it</span>, or
          just talk to Assist, and ask one of these:
        </Banner>
        <ul className="ml-1 space-y-2 text-sm">
          <Phrase>"Where are my M3 screws?"</Phrase>
          <Phrase>"Where is my ESP32 dev board?"</Phrase>
          <Phrase>"How many M3 washers do I have?"</Phrase>
        </ul>
        <p className="text-sm text-muted-foreground">
          Assist reads back the bridge's sentence, e.g.{' '}
          <span className="text-foreground">"Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock."</span> For
          an item in several places it says how it's split across them.
        </p>
      </StepCard>

      <StepCard title="Something not working?">
        <ChoiceCards
          legend="Pick the symptom that matches:"
          columns={3}
          value={trouble}
          onChange={setTrouble}
          options={[
            {
              id: 'not-found',
              title: 'Always "I could not find…"',
              description: 'It answers, but never finds items.',
            },
            {
              id: 'unreachable',
              title: '"Couldn\'t reach the bridge"',
              description: 'It says the bridge is offline.',
            },
            { id: 'nothing', title: "Assist doesn't react", description: 'It ignores the phrase entirely.' },
          ]}
        />
        {trouble === 'not-found' ? (
          <BranchPanel>
            <p className="text-sm text-muted-foreground">
              The voice path works but searches come back empty. Check the bridge actually has your data by
              querying it directly (from any machine on your network):
            </p>
            <CommandBlock
              label="search test command"
              code={`curl -H "Authorization: Bearer ${displayToken}" "http://127.0.0.1:8787/search?q=test"`}
            />
            <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
              <li>
                Empty <code className="rounded bg-secondary/60 px-1">matches</code> and{' '}
                <code className="rounded bg-secondary/60 px-1">itemCount: 0</code> at{' '}
                <code className="rounded bg-secondary/60 px-1">/health</code> → the bridge has no data. Re-run
                your sync or push (the "Feed it data" step).
              </li>
              <li>
                <code className="rounded bg-secondary/60 px-1">{`{"error":"Unauthorized"}`}</code> → the token
                changed. Re-check it matches on both sides.
              </li>
            </ul>
          </BranchPanel>
        ) : trouble === 'unreachable' ? (
          <BranchPanel>
            <p className="text-sm text-muted-foreground">
              Home Assistant can't reach the bridge at the moment it asks. The bridge may have stopped, or the
              host/IP is wrong. Confirm it's up and reachable from the Home Assistant host itself:
            </p>
            <CommandBlock
              label="reachability command"
              code={`curl -H "Authorization: Bearer ${displayToken}" "http://<BRIDGE_HOST>:8787/health"`}
            />
            <p className="text-sm text-muted-foreground">
              Run the bridge as a service (Docker or systemd, from the "Run the bridge" step) so it restarts
              on boot and doesn't quietly stop.
            </p>
          </BranchPanel>
        ) : trouble === 'nothing' ? (
          <BranchPanel>
            <p className="text-sm text-muted-foreground">
              If Assist doesn't respond at all, it hasn't learned the sentences. Re-check the "Voice
              sentences" step: the file must be at{' '}
              <code className="rounded bg-secondary/60 px-1">
                {'<config>/custom_sentences/en/gubbins.yaml'}
              </code>{' '}
              and Home Assistant must have been restarted afterwards. Try the exact phrase{' '}
              <span className="text-foreground">"where is my M3 bolt"</span> first before your own wording.
            </p>
          </BranchPanel>
        ) : null}
      </StepCard>

      <StepCard title="Where to go next" icon={<InfoIcon />}>
        <p className="text-sm text-muted-foreground">
          There's more the bridge can do — a status sensor for dashboards, a search service for automations,
          and an optional voice-driven check-in / check-out. And if you're still stuck, the full docs and a
          place to ask for help are here:
        </p>
        <div className="flex flex-col gap-1 text-sm">
          <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/homeassistant/README.md">
            Home Assistant integration guide <ExternalLinkIcon />
          </GuideLink>
          <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/bridge/README.md">
            Bridge configuration &amp; services reference <ExternalLinkIcon />
          </GuideLink>
          <GuideLink href="https://github.com/BootBlock/Gubbins/issues">
            Report an issue or ask a question <ExternalLinkIcon />
          </GuideLink>
        </div>
      </StepCard>
    </div>
  );
}

function Phrase({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-muted-foreground">
      <span aria-hidden className="text-primary [&_svg]:size-4">
        <VoiceIcon />
      </span>
      <span className="text-foreground">{children}</span>
    </li>
  );
}
