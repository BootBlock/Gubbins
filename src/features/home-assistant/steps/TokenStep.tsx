import { Banner, Button, FormField, Input, useToast } from '@/components/foundry';
import { KeyIcon, SecureIcon, SuccessIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { CommandBlock, StepCard } from '../components';
import { useGuide } from '../context';

/**
 * Step 2 — the access token.
 *
 * This step used to *generate* a token in the browser, because the bridge authenticated everyone
 * with one shared secret that lived in its `.env`. That is gone (issue #79): a token is now minted
 * per user in the app, carries exactly that user's permissions, and reaches the bridge through the
 * ordinary sync snapshot rather than through the environment.
 *
 * So the step's job changed from "make a secret" to "go and mint one, then paste it here". The
 * guide still needs the value, because Home Assistant has to be given it — but Gubbins can no
 * longer conjure one, and offering to would produce a string the bridge has never heard of.
 */
export function TokenStep() {
  const { token, setToken } = useGuide();
  const toast = useToast();
  const setBridgeToken = usePreferencesStore((s) => s.setBridgeToken);

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
          Every request to the bridge — including Home Assistant's — has to present an{' '}
          <span className="text-foreground">API token</span>. A token belongs to one Gubbins account and can
          do exactly what that account can do, no more. That is how the bridge knows who is asking, and it is
          why anything it changes is recorded against a name rather than "the bridge".
        </p>
        <Banner tone="warning" icon={<SecureIcon />} heading="Treat it like a password">
          Anyone holding this token can reach your inventory over your network as its owner. Don't paste it
          into a public chat, a screenshot, or a file you commit to git. If it ever leaks, revoke it in
          Gubbins and create a replacement — that takes effect everywhere, with no bridge restart.
        </Banner>
      </StepCard>

      <StepCard title="Create your token">
        <p className="text-sm text-muted-foreground">
          Tokens are made in Gubbins itself, not here. Go to the{' '}
          <span className="text-foreground">Users</span> screen, pick the account the bridge should act as,
          choose <span className="text-foreground">API tokens</span>, and create one. It is shown once — copy
          it straight into the field below. (Open it in a second tab if you'd rather not lose your place in
          this guide.)
        </p>
        <Banner tone="info">
          If you'd rather Home Assistant not have the run of everything, give it its own account with a narrow
          role first, and mint the token there. The bridge will hold it to exactly that role.
        </Banner>

        <FormField
          label="Bridge access token"
          hint="Starts with `gbn_`. Kept only in this browser tab unless you choose to save it below."
        >
          <Input
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="gbn_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="font-mono text-xs"
            data-testid="token-input"
          />
        </FormField>

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
    </div>
  );
}
