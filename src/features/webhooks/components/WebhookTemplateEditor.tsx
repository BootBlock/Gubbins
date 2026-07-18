/**
 * The payload template editor and its live preview (webhooks plan `W7`; see §5.3).
 *
 * The preview runs through the **real** `resolveWebhookPayload` / `renderWebhookTemplate` over a
 * real `WebhookEventView` — see `preview.ts`, which owns that logic and is unit-tested. There is
 * deliberately no second interpolator: a preview computed by different code is a guess that agrees
 * with the real payload right up until the moment someone depends on the difference.
 *
 * The one thing it will not fake is the **default envelope**. That body is built by the bridge from
 * its own `BridgeEvent`, and `src/` cannot import `bridge/`, so the editor describes its shape in
 * words rather than rendering a plausible-looking JSON body the deliverer would never send.
 */
import { useState } from 'react';
import { Surface, Textarea, SelectField } from '@/components/foundry';
import { useT, type MessageKey } from '@/features/i18n';
import type { WebhookMethod } from '@/db/repositories/constants';
import { previewWebhookPayload, WEBHOOK_PREVIEW_ENVELOPE } from '../preview';
import {
  WEBHOOK_PRESET_PREFIX,
  WEBHOOK_PRESETS,
  WEBHOOK_TEMPLATE_PATH_NAMES,
  type WebhookPreset,
} from '../template';
import {
  modeForTemplate,
  WEBHOOK_TEMPLATE_MODE_CUSTOM as CUSTOM_MODE,
  WEBHOOK_TEMPLATE_MODE_ENVELOPE as ENVELOPE_MODE,
} from '../template-mode';

const PRESET_LABEL_KEYS = {
  discord: 'webhooks.template.preset.discord',
  slack: 'webhooks.template.preset.slack',
  homeAssistant: 'webhooks.template.preset.homeAssistant',
  generic: 'webhooks.template.preset.generic',
} as const satisfies Record<WebhookPreset, MessageKey>;

export interface WebhookTemplateEditorProps {
  /** The stored template: `null` for the envelope, `preset:<name>`, or free text. */
  readonly value: string | null;
  readonly onChange: (next: string | null) => void;
  /** Decides whether the preview shows a body or a flattened query string. */
  readonly method: WebhookMethod;
}

export function WebhookTemplateEditor({ value, onChange, method }: WebhookTemplateEditorProps) {
  const t = useT();

  /**
   * The chosen mode is **held**, not re-derived from `value` on every render.
   *
   * Deriving it looks tidy and is wrong: "Custom" starts life as an empty template, an empty
   * template is indistinguishable from "no template", and so the mode would snap straight back to
   * the envelope — leaving the option impossible to select and the textarea impossible to reach.
   * The stored value stays the single source of truth for what is *sent*; this is only the source
   * of truth for which editor is on screen.
   */
  const [mode, setMode] = useState(() => modeForTemplate(value));

  const preview = previewWebhookPayload(value, method);

  const onModeChange = (next: string): void => {
    setMode(next);
    if (next === ENVELOPE_MODE) return void onChange(null);
    // A newly-chosen custom template starts empty. Until something is typed the bridge still sends
    // the standard envelope, which is exactly what the preview below goes on saying.
    if (next === CUSTOM_MODE) return void onChange('');
    onChange(`${WEBHOOK_PRESET_PREFIX}${next}`);
  };

  return (
    <div className="flex flex-col gap-field-gap">
      <SelectField
        data-testid="webhook-template-mode"
        label={t('webhooks.template.mode')}
        value={mode}
        onChange={onModeChange}
        options={[
          { value: ENVELOPE_MODE, label: t('webhooks.template.mode.envelope') },
          ...WEBHOOK_PRESETS.map((preset) => ({
            value: preset,
            label: t(PRESET_LABEL_KEYS[preset]),
          })),
          { value: CUSTOM_MODE, label: t('webhooks.template.mode.custom') },
        ]}
        hint={t('webhooks.template.modeHint')}
      />

      {mode === CUSTOM_MODE ? (
        <>
          <label className="flex flex-col gap-field-gap-compact">
            <span className="text-xs text-muted-foreground">{t('webhooks.template.body')}</span>
            <Textarea
              rows={6}
              value={value ?? ''}
              placeholder={t('webhooks.template.placeholder')}
              onChange={(event) => onChange(event.currentTarget.value)}
            />
          </label>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t('webhooks.template.placeholders')}</summary>
            <ul className="mt-2 flex flex-wrap gap-2">
              {WEBHOOK_TEMPLATE_PATH_NAMES.map((name) => (
                <li key={name}>
                  <code className="rounded bg-muted px-1.5 py-0.5">{`{{${name}}}`}</code>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}

      <section className="flex flex-col gap-field-gap-compact">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {method === 'GET' ? t('webhooks.template.previewQuery') : t('webhooks.template.preview')}
        </h3>

        {preview.unknownPaths.length > 0 ? (
          // A placeholder outside the allow-list renders empty rather than failing, which is the
          // most common way a template silently goes wrong — so it is called out, not left to be
          // discovered as a blank field on the receiving end.
          <p role="alert" className="text-xs text-warning">
            {t('webhooks.template.unknownPaths', {
              vars: { count: preview.unknownPaths.length, paths: preview.unknownPaths.join(', ') },
            })}
          </p>
        ) : null}

        <Surface className="p-3">
          {preview.kind === WEBHOOK_PREVIEW_ENVELOPE ? (
            <p className="text-xs text-muted-foreground">{t('webhooks.template.envelopeNote')}</p>
          ) : preview.text === '' ? (
            <p className="text-xs text-muted-foreground">{t('webhooks.template.previewEmpty')}</p>
          ) : (
            <pre className="overflow-x-auto text-xs text-foreground">{preview.text}</pre>
          )}
        </Surface>
      </section>
    </div>
  );
}
