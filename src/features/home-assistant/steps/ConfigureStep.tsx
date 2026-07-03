import { useState } from 'react';
import { Banner } from '@/components/foundry';
import { CloudIcon, InfoIcon, SettingsIcon, SuccessIcon, WarningIcon } from '@/components/icons';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';
import { useGuide, tokenForDisplay } from '../context';

type AddMethod = 'discovery' | 'manual';
type Outcome = 'ok' | 'unreachable' | 'token' | null;

/**
 * Step 6 — connect Home Assistant to the bridge (custom-integration path).
 *
 * Branches on how the integration is added: auto-discovery (mDNS pre-fills host/port) or manual
 * entry. Both converge on entering the token, then an outcome selector maps the two verification
 * errors the config flow can show ("could not reach" / "rejected token") to a concrete fix.
 */
export function ConfigureStep() {
  const { token } = useGuide();
  const displayToken = tokenForDisplay(token);
  const [method, setMethod] = useState<AddMethod | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  return (
    <div className="space-y-6">
      <StepCard title="Point Home Assistant at the bridge" icon={<SettingsIcon />}>
        <p className="text-sm text-muted-foreground">
          With the integration installed and Home Assistant restarted, you now tell it where the bridge is and
          give it the token. Home Assistant verifies the connection before saving, so you'll know immediately
          if something's off.
        </p>
        <Banner tone="info" icon={<InfoIcon />}>
          Used the <span className="text-foreground">no-code YAML</span> recipe on the previous step? You can
          skip this step — there's no setup screen to fill in. Head straight to "Voice sentences".
        </Banner>
      </StepCard>

      <ChoiceCards
        legend="How will you add it?"
        value={method}
        onChange={setMethod}
        options={[
          {
            id: 'discovery',
            title: 'It was auto-discovered',
            description: 'A "Gubbins Inventory" card already appeared in HA.',
            Icon: CloudIcon,
          },
          {
            id: 'manual',
            title: "I'll add it manually",
            description: 'Type the host, port and token myself.',
            Icon: SettingsIcon,
          },
        ]}
      />

      {method === 'discovery' ? (
        <BranchPanel>
          <StepCard title="Finish the discovered card">
            <p className="text-sm text-muted-foreground">
              If you started the bridge with mDNS enabled on your LAN, Home Assistant finds it on its own.
            </p>
            <ol className="ml-4 list-decimal space-y-2 text-sm text-muted-foreground">
              <li>
                Open <span className="text-foreground">Settings → Devices &amp; services</span>. A{' '}
                <span className="text-foreground">Gubbins Inventory</span> discovered card should be waiting
                (the host and port are already filled in).
              </li>
              <li>
                Click <span className="text-foreground">Configure</span> and enter just the{' '}
                <span className="text-foreground">access token</span> — the token is never advertised, so you
                always type it.
              </li>
            </ol>
            <TokenReminder token={displayToken} />
            <Banner tone="info" icon={<InfoIcon />}>
              No card appeared? mDNS may be blocked between the two machines (VLANs, Wi-Fi client isolation),
              or you didn't start the bridge with{' '}
              <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_MDNS=on</code> and{' '}
              <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_HOST=0.0.0.0</code>. Just add it
              manually instead — the result is identical.
            </Banner>
          </StepCard>
        </BranchPanel>
      ) : method === 'manual' ? (
        <BranchPanel>
          <StepCard title="Add it manually">
            <ol className="ml-4 list-decimal space-y-2 text-sm text-muted-foreground">
              <li>
                Open{' '}
                <span className="text-foreground">Settings → Devices &amp; services → Add integration</span>.
              </li>
              <li>
                Search for <span className="text-foreground">Gubbins Inventory</span>.
              </li>
              <li>
                Enter the <span className="text-foreground">host</span> (e.g.{' '}
                <code className="rounded bg-secondary/60 px-1">127.0.0.1</code> if the bridge is on the HA
                machine, otherwise the bridge's LAN IP or hostname), the{' '}
                <span className="text-foreground">port</span> (default{' '}
                <code className="rounded bg-secondary/60 px-1">8787</code>), and the{' '}
                <span className="text-foreground">access token</span>.
              </li>
            </ol>
            <TokenReminder token={displayToken} />
          </StepCard>
        </BranchPanel>
      ) : null}

      {method ? (
        <StepCard title="What did Home Assistant say?">
          <ChoiceCards
            legend="After you submit, the connection is checked. What happened?"
            value={outcome}
            onChange={setOutcome}
            options={[
              {
                id: 'ok',
                title: 'It saved successfully',
                description: 'The integration was added.',
                Icon: SuccessIcon,
              },
              {
                id: 'unreachable',
                title: '"Could not reach the bridge"',
                description: 'A connection failure.',
              },
              { id: 'token', title: '"The bridge rejected the token"', description: 'An auth failure.' },
            ]}
          />
          {outcome === 'ok' ? (
            <BranchPanel>
              <Banner tone="success" icon={<SuccessIcon />} heading="Connected">
                Home Assistant can now talk to your inventory. One more step — teaching Assist the phrases to
                listen for — and you're done.
              </Banner>
            </BranchPanel>
          ) : outcome === 'unreachable' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                Home Assistant couldn't open a connection to the host/port you gave. Check, in order:
              </p>
              <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
                <li>The bridge is actually running (its terminal/log shows it listening).</li>
                <li>
                  The host is right. If HA is on a <span className="text-foreground">different</span> machine
                  from the bridge, <code className="rounded bg-secondary/60 px-1">127.0.0.1</code> won't work
                  — use the bridge machine's LAN IP.
                </li>
                <li>
                  The bridge is exposed on the LAN. On a different machine it must be started with{' '}
                  <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_HOST=0.0.0.0</code>.
                </li>
              </ul>
              <p className="text-sm text-muted-foreground">
                Confirm reachability from the Home Assistant host itself:
              </p>
              <CommandBlock
                label="reachability command"
                code={`curl -H "Authorization: Bearer ${displayToken}" "http://<BRIDGE_HOST>:8787/health"`}
              />
            </BranchPanel>
          ) : outcome === 'token' ? (
            <BranchPanel>
              <p className="text-sm text-muted-foreground">
                The bridge is reachable, but the token you entered doesn't match the bridge's{' '}
                <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_TOKEN</code>. They must be
                byte-for-byte identical.
              </p>
              <Banner tone="warning" icon={<WarningIcon />}>
                Watch for a trailing space or a truncated paste. If in doubt, generate a fresh token on the
                "Access token" step, set it on the bridge (and restart the bridge), then enter the same value
                here.
              </Banner>
            </BranchPanel>
          ) : null}
        </StepCard>
      ) : null}
    </div>
  );
}

/** A small reminder of the token to type into Home Assistant, using the guide's own value. */
function TokenReminder({ token }: { readonly token: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">The token to enter (from the "Access token" step):</p>
      <CommandBlock label="access token" code={token} />
    </div>
  );
}
