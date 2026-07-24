import { useState } from 'react';
import { Banner } from '@/components/foundry';
import {
  ExtensionIcon,
  ExternalLinkIcon,
  InfoIcon,
  PackageIcon,
  TerminalIcon,
  WarningIcon,
} from '@/components/icons';
import { useT } from '@/features/i18n';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';
import { useGuide, tokenForDisplay } from '../context';
import { GuideLink } from '../links';

type InstallMethod = 'hacs' | 'manual' | 'yaml';

/**
 * Step 5 — install the Gubbins integration into Home Assistant.
 *
 * Three routes: HACS (recommended, gives the config-flow UI, service and sensor), a manual copy
 * of the integration folder, or a no-code YAML recipe that gets the voice intent alone without
 * installing any custom component. The choice changes what the *next* step ("Connect") looks
 * like, which we flag here.
 */
export function IntegrationStep() {
  const t = useT();
  const { token } = useGuide();
  const displayToken = tokenForDisplay(token);
  const [method, setMethod] = useState<InstallMethod | null>(null);

  return (
    <div className="space-y-6">
      <StepCard title="Two kinds of install" icon={<ExtensionIcon />}>
        <p className="text-sm text-muted-foreground">
          There are two families of setup. The <span className="text-foreground">custom integration</span>{' '}
          (via HACS or a manual copy) is recommended: it gives you a proper setup screen in Home Assistant,
          plus a search service and a status sensor. The <span className="text-foreground">no-code YAML</span>{' '}
          recipe skips installing anything and just wires up the voice question — good if you'd rather not add
          a custom component.
        </p>
        <p className="text-sm text-muted-foreground">{t('homeAssistant.install.minVersion')}</p>
      </StepCard>

      <ChoiceCards
        legend="How would you like to install it?"
        columns={3}
        value={method}
        onChange={setMethod}
        options={[
          {
            id: 'hacs',
            title: 'HACS',
            description: 'Recommended. A few clicks, auto-updates.',
            Icon: PackageIcon,
          },
          {
            id: 'manual',
            title: 'Manual copy',
            description: 'Copy the folder yourself. No HACS.',
            Icon: ExtensionIcon,
          },
          {
            id: 'yaml',
            title: 'No-code YAML',
            description: 'Voice only, no custom component.',
            Icon: TerminalIcon,
          },
        ]}
      />

      {method === 'hacs' ? (
        <BranchPanel>
          <StepCard title="Install via HACS">
            <ol className="ml-4 list-decimal space-y-2 text-sm text-muted-foreground">
              <li>
                In Home Assistant open <span className="text-foreground">HACS</span>, then the menu (⋮) →{' '}
                <span className="text-foreground">Custom repositories</span>.
              </li>
              <li>
                Add the repository <code className="rounded bg-secondary/60 px-1">BootBlock/Gubbins</code> and
                choose category <span className="text-foreground">Integration</span>.
              </li>
              <li>
                Install <span className="text-foreground">Gubbins Inventory</span> from the list, then{' '}
                <span className="text-foreground">restart Home Assistant</span>.
              </li>
            </ol>
            <Banner
              tone="warning"
              icon={<InfoIcon />}
              heading="Point HACS at the repository, not a sub-folder"
            >
              Use the <code className="rounded bg-secondary/60 px-1">BootBlock/Gubbins</code> form (or the
              full repo URL). A link to a sub-path like{' '}
              <code className="rounded bg-secondary/60 px-1">…/tree/main/homeassistant</code> is{' '}
              <span className="text-foreground">not</span> a valid custom repository and gives a "structure is
              not compliant" error.
            </Banner>
            <ContinueNote>the UI setup — go to the next step to add and connect it.</ContinueNote>
          </StepCard>
        </BranchPanel>
      ) : method === 'manual' ? (
        <BranchPanel>
          <StepCard title="Copy the integration folder">
            <p className="text-sm text-muted-foreground">
              The integration lives at the <span className="text-foreground">root</span> of the Gubbins
              repository. Copy that folder into your Home Assistant config directory so you end up with:
            </p>
            <CommandBlock label="target path" code={`<config>/custom_components/gubbins/`} />
            <p className="text-sm text-muted-foreground">
              (Copy it from <code className="rounded bg-secondary/60 px-1">custom_components/gubbins/</code>{' '}
              in the repository root.) Then <span className="text-foreground">restart Home Assistant</span>.
            </p>
            <ContinueNote>the UI setup — go to the next step to add and connect it.</ContinueNote>
          </StepCard>
        </BranchPanel>
      ) : method === 'yaml' ? (
        <BranchPanel>
          <StepCard title="No-code YAML recipe">
            <p className="text-sm text-muted-foreground">
              This gets you the voice question without any custom component. Because there's no setup UI, the
              token lives in your local <code className="rounded bg-secondary/60 px-1">secrets.yaml</code>{' '}
              (never commit that file).
            </p>
            <p className="text-sm text-muted-foreground">
              1. In <code className="rounded bg-secondary/60 px-1">secrets.yaml</code>, store the whole header
              value (so the word "Bearer" stays out of the main config):
            </p>
            <CommandBlock
              label="secrets.yaml line"
              caption="secrets.yaml"
              code={`gubbins_bridge_token_header: "Bearer ${displayToken}"`}
            />
            <p className="text-sm text-muted-foreground">
              2. In <code className="rounded bg-secondary/60 px-1">configuration.yaml</code>, add the REST
              command and intent (adjust the host/port if the bridge isn't local):
            </p>
            <CommandBlock
              label="configuration.yaml snippet"
              caption="configuration.yaml"
              code={YAML_RECIPE}
            />
            <Banner tone="info" icon={<InfoIcon />}>
              You still need the voice sentences from the "Voice sentences" step. With the YAML recipe you can{' '}
              <span className="text-foreground">skip the next "Connect" step</span> — there's no config-flow
              UI to fill in.
            </Banner>
            <Banner tone="warning" icon={<WarningIcon />} heading="If Home Assistant mangles the URL">
              On some setups <code className="rounded bg-secondary/60 px-1">rest_command</code> can truncate a
              URL that combines a custom port with a template. If replies are always "not found", switch to
              the <span className="text-foreground">conversation automation</span> option on the "Voice
              sentences" step instead — it uses a{' '}
              <code className="rounded bg-secondary/60 px-1">shell_command</code> +{' '}
              <code className="rounded bg-secondary/60 px-1">curl</code>, which sidesteps the quirk entirely.
            </Banner>
            <p className="text-sm text-muted-foreground">
              The full recipe and a dashboard-sensor variant are in the{' '}
              <GuideLink href="https://github.com/BootBlock/Gubbins/blob/main/homeassistant/README.md">
                Home Assistant README <ExternalLinkIcon />
              </GuideLink>
              .
            </p>
          </StepCard>
        </BranchPanel>
      ) : null}
    </div>
  );
}

function ContinueNote({ children }: { children: React.ReactNode }) {
  return (
    <Banner tone="info" icon={<InfoIcon />}>
      This install gives you {children}
    </Banner>
  );
}

const YAML_RECIPE = `rest_command:
  gubbins_where_is:
    url: "http://127.0.0.1:8787/where?q={{ item | urlencode }}"
    method: GET
    headers:
      Authorization: !secret gubbins_bridge_token_header
    timeout: 10

intent_script:
  GubbinsWhereIs:
    action:
      - service: rest_command.gubbins_where_is
        data:
          item: "{{ item }}"
        response_variable: action_response
    speech:
      text: >
        {% if action_response is defined and action_response.content is defined
              and action_response.content.spoken is defined %}
          {{ action_response.content.spoken }}
        {% else %}
          Sorry, I couldn't reach the Gubbins inventory bridge just now.
        {% endif %}`;
