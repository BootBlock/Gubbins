import { useState } from 'react';
import { Banner } from '@/components/foundry';
import { InfoIcon, ServerIcon, CloudUploadIcon, VoiceIcon } from '@/components/icons';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';

/**
 * Step 1 — Overview & prerequisites.
 *
 * Sets expectations before any typing: what the finished setup does, the shape of the data
 * path, and a checklist of what the user needs. It branches on whether they have already got
 * the bridge running, so a returning user can skip the parts they've done.
 */
export function OverviewStep() {
  const [familiarity, setFamiliarity] = useState<'new' | 'bridge-running' | null>(null);

  return (
    <div className="space-y-6">
      <StepCard title="What you are about to build" icon={<InfoIcon />}>
        <p className="text-sm text-muted-foreground">
          By the end of this guide you'll be able to ask your Home Assistant voice assistant{' '}
          <span className="text-foreground">"Where are my M3 screws?"</span> and hear the answer from your
          Gubbins inventory — entirely on your own network, with nothing sent to any cloud.
        </p>
        <p className="text-sm text-muted-foreground">
          It works through three pieces. Gubbins (this app) exports your data; a small{' '}
          <span className="text-foreground">bridge</span> service runs on your own hardware and answers
          read-only questions over your LAN; and Home Assistant asks the bridge and speaks the reply.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <PathCard
            icon={<CloudUploadIcon />}
            title="1. Gubbins"
            body="Exports your inventory as a snapshot."
          />
          <PathCard
            icon={<ServerIcon />}
            title="2. The bridge"
            body="Reads the snapshot; answers over HTTP."
          />
          <PathCard
            icon={<VoiceIcon />}
            title="3. Home Assistant"
            body="Asks the bridge; speaks the answer."
          />
        </div>
        <Banner tone="info" icon={<InfoIcon />} heading="Everything stays local">
          Nothing here talks to a server on the internet. The bridge only ever reads your data, and only your
          own devices on your own network can reach it.
        </Banner>
      </StepCard>

      <StepCard title="What you'll need">
        <ul className="ml-1 space-y-2 text-sm text-muted-foreground">
          <ChecklistItem>
            <span className="text-foreground">Home Assistant</span> running (Home Assistant OS, Container, or
            Core).
          </ChecklistItem>
          <ChecklistItem>
            A machine that can run <span className="text-foreground">Node.js 24+</span> (or 22.16+ LTS) or
            Docker, that both sees your Gubbins data and can be reached by Home Assistant. This can be the
            Home Assistant host itself, a Raspberry Pi, or a NAS.
          </ChecklistItem>
          <ChecklistItem>
            A checkout of the <span className="text-foreground">Gubbins repository</span> on that machine (the
            bridge ships inside it). We'll cover getting it in the next steps.
          </ChecklistItem>
          <ChecklistItem>
            About <span className="text-foreground">15–20 minutes</span>. You do not need to be a programmer —
            every command is copy-and-paste.
          </ChecklistItem>
        </ul>
      </StepCard>

      <ChoiceCards
        legend="Before we start — where are you?"
        value={familiarity}
        onChange={setFamiliarity}
        options={[
          {
            id: 'new',
            title: "I'm starting from scratch",
            description: 'You have Home Assistant, but no Gubbins bridge yet.',
            Icon: InfoIcon,
          },
          {
            id: 'bridge-running',
            title: 'My bridge is already running',
            description: 'You just want to connect Home Assistant to it.',
            Icon: ServerIcon,
          },
        ]}
      />

      {familiarity === 'new' ? (
        <BranchPanel>
          <p className="text-sm text-muted-foreground">
            Perfect — we'll go through it together, one step at a time. Start by creating the access token on
            the next step: it's the shared secret that lets Home Assistant talk to the bridge, and later steps
            will slot it into the commands for you automatically.
          </p>
        </BranchPanel>
      ) : familiarity === 'bridge-running' ? (
        <BranchPanel>
          <p className="text-sm text-muted-foreground">
            Great. You can still skim the next couple of steps, but the important thing is that you know the
            bridge's <span className="text-foreground">host</span>,{' '}
            <span className="text-foreground">port</span> and{' '}
            <span className="text-foreground">access token</span> — you'll enter those into Home Assistant on
            the "Connect" step. If you want a quick sanity check that the bridge is up and your token is
            right, run this from a terminal on any machine on your network (replace the host and token):
          </p>
          <CommandBlock
            label="bridge health-check command"
            code={`curl -H "Authorization: Bearer <YOUR_BRIDGE_TOKEN>" "http://127.0.0.1:8787/health"`}
          />
          <p className="text-sm text-muted-foreground">
            A JSON reply with <code className="rounded bg-secondary/60 px-1">"ok": true</code> means you're
            ready to jump to the "Install in HA" step.
          </p>
        </BranchPanel>
      ) : null}
    </div>
  );
}

function PathCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/30 p-3">
      <div className="flex items-center gap-2 text-primary [&_svg]:size-4">
        {icon}
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

function ChecklistItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/70" />
      <span>{children}</span>
    </li>
  );
}
