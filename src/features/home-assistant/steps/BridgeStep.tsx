import { useState } from 'react';
import { Banner } from '@/components/foundry';
import {
  CloudIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  InfoIcon,
  ScaleIcon,
  ServerIcon,
  TerminalIcon,
  WarningIcon,
} from '@/components/icons';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';
import { useGuide, tokenForDisplay } from '../context';
import { GuideLink } from '../links';

type Placement = 'same-host' | 'other-host';
type RunMethod = 'node' | 'docker' | 'systemd';
type Outcome = 'ok' | 'port' | 'node' | 'other';

const SNAPSHOT_PLACEHOLDER = '/path/to/your/gubbins-sync.json';
/** Stand-in for the user's own Home Assistant long-lived token — never a real value. */
const HA_TOKEN_PLACEHOLDER = '<YOUR_HOME_ASSISTANT_TOKEN>';

/**
 * Step 3 — run the bridge.
 *
 * The most branch-heavy step. It first establishes *where* the bridge runs relative to Home
 * Assistant (which decides whether it must be exposed on the LAN), then offers three ways to
 * run it (bare Node, Docker, systemd) with the token already spliced into every command, and
 * then an outcome selector that routes common startup problems to a fix, and finally the one
 * optional capability that is also configured here: reading a Home Assistant scale entity.
 */
export function BridgeStep() {
  const { token } = useGuide();
  const displayToken = tokenForDisplay(token);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [method, setMethod] = useState<RunMethod | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const exposed = placement === 'other-host';
  const bindHost = exposed ? '0.0.0.0' : '127.0.0.1';

  return (
    <div className="space-y-6">
      <StepCard title="What the bridge is" icon={<ServerIcon />}>
        <p className="text-sm text-muted-foreground">
          Gubbins runs entirely in your browser, so it can't host a network address that Home Assistant can
          call. The <span className="text-foreground">bridge</span> is a tiny companion service that closes
          that gap: it reads a copy of your data and answers read-only questions over HTTP. It has no database
          of its own and never writes to your inventory.
        </p>
        <p className="text-sm text-muted-foreground">
          It ships <span className="text-foreground">inside the Gubbins repository</span>, so first get a copy
          onto the machine that will run it, then install the toolchain it borrows:
        </p>
        <CommandBlock
          label="clone and install command"
          code={`git clone https://github.com/BootBlock/Gubbins.git\ncd Gubbins\nnpm install`}
        />
        <Banner tone="info" icon={<InfoIcon />} heading="Node.js 24+ (or 22.16+ LTS) is required">
          The bridge needs a modern Node for its built-in SQLite with full-text search. Node 23.x specifically
          will <span className="text-foreground">not</span> work. Check yours with{' '}
          <code className="rounded bg-secondary/60 px-1">node --version</code>.
        </Banner>
      </StepCard>

      <StepCard title="Where will the bridge run?">
        <ChoiceCards
          legend="Is this the same machine that runs Home Assistant?"
          value={placement}
          onChange={setPlacement}
          options={[
            {
              id: 'same-host',
              title: 'Same machine as Home Assistant',
              description: 'The bridge stays private on loopback — nothing touches the LAN.',
              Icon: ServerIcon,
            },
            {
              id: 'other-host',
              title: 'A different machine',
              description: 'A Raspberry Pi, NAS, or PC. We expose it on your LAN so HA can reach it.',
              Icon: CloudIcon,
            },
          ]}
        />
        {placement ? (
          <BranchPanel>
            {exposed ? (
              <p className="text-sm text-muted-foreground">
                We'll bind the bridge to <code className="rounded bg-secondary/60 px-1">0.0.0.0</code> so
                other machines on your network can reach it. Note the bridge machine's LAN address (e.g.{' '}
                <code className="rounded bg-secondary/60 px-1">192.0.2.10</code> or{' '}
                <code className="rounded bg-secondary/60 px-1">gubbins.local</code>) — you'll give it to Home
                Assistant on the "Connect" step. Keep your firewall tight; only expose it on a network you
                trust.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                We'll keep the bridge on <code className="rounded bg-secondary/60 px-1">127.0.0.1</code>{' '}
                (loopback) — the safest option. Home Assistant will reach it at{' '}
                <code className="rounded bg-secondary/60 px-1">127.0.0.1:8787</code>.
              </p>
            )}
          </BranchPanel>
        ) : null}
      </StepCard>

      {placement ? (
        <StepCard title="How do you want to run it?">
          <ChoiceCards
            legend="Pick whichever you're most comfortable with — all three do the same thing."
            columns={3}
            value={method}
            onChange={setMethod}
            options={[
              {
                id: 'node',
                title: 'Node directly',
                description: 'Simplest to try. One command.',
                Icon: TerminalIcon,
              },
              { id: 'docker', title: 'Docker', description: 'Self-contained container.', Icon: DatabaseIcon },
              {
                id: 'systemd',
                title: 'systemd service',
                description: 'Always-on Linux service.',
                Icon: ServerIcon,
              },
            ]}
          />

          {method === 'node' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                Create a <span className="text-foreground">git-ignored</span>{' '}
                <code className="rounded bg-secondary/60 px-1">bridge/.env</code> file with your settings. The
                snapshot path is where your inventory data lives — the next step covers how to produce it, so
                for now just note the path you'll use.
              </p>
              <CommandBlock
                label="bridge/.env contents"
                caption="bridge/.env"
                code={envFileContents(displayToken, exposed)}
              />
              <p className="text-sm text-muted-foreground">Then start it from the repository root:</p>
              <CommandBlock label="start command" code={`node bridge/serve.mjs`} />
            </BranchPanel>
          ) : method === 'docker' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                Build the image (the build context is the repository root), then run it. The token and
                snapshot are passed at run time — never baked into the image.
              </p>
              <CommandBlock
                label="docker build command"
                code={`docker build -f bridge/Dockerfile -t gubbins-bridge .`}
              />
              <CommandBlock label="docker run command" code={dockerRunCommand(displayToken, bindHost)} />
              <p className="text-sm text-muted-foreground">
                Replace <code className="rounded bg-secondary/60 px-1">{SNAPSHOT_PLACEHOLDER}</code> with the
                real path to your data file (covered next). Mounting it{' '}
                <code className="rounded bg-secondary/60 px-1">:ro</code> keeps it read-only.
              </p>
            </BranchPanel>
          ) : method === 'systemd' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                For an always-on Linux host, run it as a hardened systemd service. The repository ships an
                example unit and env file. In short: put a checkout at{' '}
                <code className="rounded bg-secondary/60 px-1">/opt/gubbins</code>, create{' '}
                <code className="rounded bg-secondary/60 px-1">/etc/gubbins-bridge.env</code> (holding your
                token), install the unit, then:
              </p>
              <CommandBlock
                label="systemd env file contents"
                caption="/etc/gubbins-bridge.env"
                code={envFileContents(displayToken, exposed)}
              />
              <CommandBlock
                label="systemd enable command"
                code={`sudo systemctl daemon-reload\nsudo systemctl enable --now gubbins-bridge\njournalctl -u gubbins-bridge -f`}
              />
              <p className="text-sm text-muted-foreground">
                The full walkthrough (the example{' '}
                <code className="rounded bg-secondary/60 px-1">gubbins-bridge.service</code> unit and its
                sandboxing) is in the{' '}
                <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/bridge/README.md">
                  bridge README <ExternalLinkIcon />
                </GuideLink>
                .
              </p>
            </BranchPanel>
          ) : null}
        </StepCard>
      ) : null}

      {method ? (
        <StepCard title="Did it start?">
          <ChoiceCards
            legend="Run the start command — what happened?"
            value={outcome}
            onChange={setOutcome}
            options={[
              {
                id: 'ok',
                title: 'It printed that it is listening',
                description: 'A "Serving on…" line, no errors.',
              },
              { id: 'port', title: 'Address already in use', description: 'A port conflict on 8787.' },
              {
                id: 'node',
                title: 'A SQLite / fts5 error',
                description: '"no such module: fts5" or a Node error.',
              },
              { id: 'other', title: 'Something else', description: 'It exited or printed another error.' },
            ]}
          />
          {outcome === 'ok' ? (
            <BranchPanel>
              <Banner tone="success" icon={<ServerIcon />} heading="The bridge is running">
                Leave it running. Next we'll make sure it actually has your inventory data to answer from.
              </Banner>
            </BranchPanel>
          ) : outcome === 'port' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                Something else is already using port{' '}
                <code className="rounded bg-secondary/60 px-1">8787</code>. Either stop that, or run the
                bridge on another port by adding this to your env and using the new port everywhere:
              </p>
              <CommandBlock label="alternate port setting" code={`GUBBINS_BRIDGE_PORT=8788`} />
            </BranchPanel>
          ) : outcome === 'node' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                This almost always means Node is too old, or is a 23.x build (which lacks the full-text search
                the database needs). Check with{' '}
                <code className="rounded bg-secondary/60 px-1">node --version</code> and install{' '}
                <span className="text-foreground">Node 24+</span> or{' '}
                <span className="text-foreground">22.16+ LTS</span>. Docker (the option above) sidesteps this
                entirely by bringing its own Node.
              </p>
            </BranchPanel>
          ) : outcome === 'other' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                A missing required setting (the token or snapshot path) makes the bridge exit immediately with
                a clear message — re-check your env values. If the message mentions the snapshot file, that's
                expected until you complete the next step. The{' '}
                <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/bridge/README.md">
                  bridge README <ExternalLinkIcon />
                </GuideLink>{' '}
                lists every setting and error.
              </p>
              <Banner tone="warning" icon={<WarningIcon />}>
                If the error names the snapshot path, continue to the next step — it explains how to create
                that file — then start the bridge again.
              </Banner>
            </BranchPanel>
          ) : null}
        </StepCard>
      ) : null}

      <StepCard title="Optional: read a scale from Home Assistant" icon={<ScaleIcon />}>
        <p className="text-sm text-muted-foreground">
          If you already have a scale exposed to Home Assistant, the bridge can read it for you. With this
          turned on, Gubbins' <span className="text-foreground">Count by weight</span> dialog gains a scale
          picker and a <span className="text-foreground">Read the scale</span> button that pulls the live
          weight straight into the "Weight on scale" field — instead of you reading the display and typing the
          figure in.
        </p>
        <p className="text-sm text-muted-foreground">
          It is <span className="text-foreground">off unless you switch it on</span>, and typing the weight by
          hand stays the default either way. To enable it, add these three lines to the same env file as above
          and restart the bridge:
        </p>
        <CommandBlock
          label="Home Assistant read settings"
          code={haEnvSettings()}
          caption="added to bridge/.env"
        />
        <p className="text-sm text-muted-foreground">
          <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_HA_URL</code> is your Home Assistant's
          own address. The token is a <span className="text-foreground">Home Assistant</span> long-lived
          access token — a different secret from the bridge token above. Create one from your Home Assistant{' '}
          <span className="text-foreground">profile → Security → Long-lived access tokens</span>, and prefer
          an account that has only the access it needs over your main administrator login.
        </p>
        <p className="text-sm text-muted-foreground">
          If you'd rather not type the address, add{' '}
          <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_HA_DISCOVERY=on</code> and leave the
          URL line out — the bridge looks for Home Assistant on your network at startup and uses the address
          it advertises. A URL you set yourself always wins, and the token is still needed either way.
        </p>
        <Banner tone="info" icon={<InfoIcon />} heading="The Home Assistant token stays on the bridge">
          It lives in the bridge's env file and never reaches the app — the app only ever receives the
          resulting weight. The read is outbound-only and read-only: the bridge opens no extra port, and it
          can only read a sensor's state, never call a Home Assistant service, so it can't switch or unlock
          anything in your home.
        </Banner>
        <p className="text-sm text-muted-foreground">
          The app finds the bridge using the URL and token you set under{' '}
          <span className="text-foreground">Push to bridge</span> on the Cloud Sync screen (covered on the
          next step). Skip all of this if you don't need it — nothing else in the guide changes.
        </p>
      </StepCard>
    </div>
  );
}

/**
 * The opt-in Home Assistant read settings. The Home Assistant token is the *user's own* secret —
 * unlike the bridge token, the guide can't generate it, so it is only ever shown as a placeholder.
 */
function haEnvSettings(): string {
  return [
    'GUBBINS_BRIDGE_HA=on',
    'GUBBINS_BRIDGE_HA_URL=http://homeassistant.local:8123',
    `GUBBINS_BRIDGE_HA_TOKEN=${HA_TOKEN_PLACEHOLDER}`,
  ].join('\n');
}

/** The `.env` / env-file body, with the token filled in and LAN exposure added when needed. */
function envFileContents(token: string, exposed: boolean): string {
  const lines = [`GUBBINS_BRIDGE_TOKEN=${token}`, `GUBBINS_SNAPSHOT_PATH=${SNAPSHOT_PLACEHOLDER}`];
  if (exposed) lines.push('GUBBINS_BRIDGE_HOST=0.0.0.0');
  return lines.join('\n');
}

/** The `docker run` command, publishing to loopback or the LAN depending on placement. */
function dockerRunCommand(token: string, bindHost: string): string {
  return [
    'docker run --rm \\',
    `  -p ${bindHost}:8787:8787 \\`,
    `  -e GUBBINS_BRIDGE_TOKEN=${token} \\`,
    '  -e GUBBINS_SNAPSHOT_PATH=/data/gubbins-sync.json \\',
    `  -v ${SNAPSHOT_PLACEHOLDER}:/data/gubbins-sync.json:ro \\`,
    '  gubbins-bridge',
  ].join('\n');
}
