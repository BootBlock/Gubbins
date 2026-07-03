import { useState } from 'react';
import { Banner, Button, FormField, Input, useToast } from '@/components/foundry';
import { KeyIcon, RefreshIcon, SecureIcon, SuccessIcon, TerminalIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { CommandBlock, StepCard } from '../components';
import { useGuide } from '../context';
import { generateBridgeToken } from '../token';

/**
 * Step 2 — the access token.
 *
 * The bridge authenticates every request with a shared bearer token. This step can mint a
 * strong one in the browser (Web Crypto) so a user without a terminal isn't stuck, explains
 * exactly where it goes, and — since the token is a secret the later steps need — keeps it in
 * guide state so "Run the bridge" and "Connect" can fill it in automatically. The user may also
 * paste a token they already have.
 */
export function TokenStep() {
  const { token, setToken } = useGuide();
  const toast = useToast();
  const setBridgeToken = usePreferencesStore((s) => s.setBridgeToken);
  const [justGenerated, setJustGenerated] = useState(false);

  const generate = () => {
    setToken(generateBridgeToken());
    setJustGenerated(true);
  };

  const saveToDevice = () => {
    setBridgeToken(token.trim());
    toast.show({
      tone: 'success',
      icon: <SuccessIcon />,
      message: 'Token saved to this device — the Cloud Sync screen will use it for "Push to bridge".',
    });
  };

  const hasToken = token.trim().length > 0;

  return (
    <div className="space-y-6">
      <StepCard title="What a token is, and why you need one" icon={<KeyIcon />}>
        <p className="text-sm text-muted-foreground">
          The bridge is protected by a single <span className="text-foreground">access token</span> — a long
          random secret. Every request (including Home Assistant's) must present it, so nobody else on your
          network can read your inventory. You'll use the <span className="text-foreground">same</span> token
          in two places: the bridge (as{' '}
          <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_TOKEN</code>) and Home Assistant.
        </p>
        <Banner tone="warning" icon={<SecureIcon />} heading="Treat it like a password">
          Anyone with this token can read your inventory over your network. Don't paste it into a public chat,
          screenshot, or a file you commit to git. If it ever leaks, come back here, generate a new one, and
          update both places.
        </Banner>
      </StepCard>

      <StepCard title="Create your token">
        <p className="text-sm text-muted-foreground">
          Let Gubbins generate a strong token for you here in your browser, or paste one you already have.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={generate} data-testid="generate-token">
            <RefreshIcon />
            Generate {hasToken ? 'a new' : 'a'} token
          </Button>
        </div>

        <FormField
          label="Bridge access token"
          hint="A 64-character random hex string (256 bits of entropy). Kept only in this browser tab unless you choose to save it below."
        >
          <Input
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Generate one above, or paste your own"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setJustGenerated(false);
            }}
            className="font-mono text-xs"
            data-testid="token-input"
          />
        </FormField>

        {justGenerated ? (
          <Banner tone="success" icon={<SuccessIcon />} data-testid="token-generated">
            A fresh token is ready. Copy it now — the next steps will fill it into the commands for you
            automatically, but you'll also need it to hand.
          </Banner>
        ) : null}

        {hasToken ? (
          <div className="space-y-4">
            <CommandBlock label="access token" caption="Your token — keep it safe" code={token.trim()} />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={saveToDevice} data-testid="save-token-device">
                <SuccessIcon />
                Save to this device
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              "Save to this device" stores the token in this browser only (for the app's own "Push to bridge"
              feature). It is never synced or sent anywhere.
            </p>
          </div>
        ) : null}
      </StepCard>

      <StepCard title="Prefer to make it yourself?" icon={<TerminalIcon />}>
        <p className="text-sm text-muted-foreground">
          Any long random string works. If you'd rather generate it in a terminal on the machine that will run
          the bridge, this prints a good one:
        </p>
        <CommandBlock
          label="token generation command"
          code={`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`}
        />
        <p className="text-sm text-muted-foreground">
          Paste the result into the field above so the rest of the guide can use it, or just keep it handy.
        </p>
      </StepCard>
    </div>
  );
}
