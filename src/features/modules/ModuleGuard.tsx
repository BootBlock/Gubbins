/**
 * Route guard + "module hidden" interstitial (modular-ui-plan §4, Phase 5).
 *
 * Wraps the screen an optional page route renders. When the route's feature is effectively
 * on, the children (the real screen) render unchanged — the guard is transparent. When the
 * feature is off, we render a gentle interstitial in place (no redirect) explaining the
 * module is hidden, with two ways forward:
 *
 *  - **Show this module** flips the feature's stored intent back on (and, if the feature has
 *    dependencies that are themselves off, first confirms the knock-on switches via the same
 *    `ConfirmCascadeModal` the Modules screen uses). Re-enabling immediately reveals the
 *    screen because `useFeature` re-resolves to on. That is a write to the module list, and this
 *    interstitial is a second door onto it, so it is offered only to a role holding
 *    `modules:write` (issue #429).
 *  - **Continue anyway** renders the real screen just this once via a local override, without
 *    touching intent — the module stays hidden everywhere else.
 *
 * The interstitial composes the Foundry `PageHeader` (so the global nav + skip-link wiring
 * stay intact) over the shared `Interstitial` primitive, which owns the `<main>` landmark and the
 * centred-notice shell it has in common with the read-permission refusal (issue #522).
 */
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Interstitial, PageContainer, PageHeader } from '@/components/foundry';
import { HideIcon, ModulesIcon, ShowIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/foundry/button';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { ROUTE_PERMISSIONS } from '@/components/nav/nav-destinations';
import { usePermission } from '@/features/users/usePermission';
import { ConfirmCascadeModal, type PendingCascade } from './ConfirmCascadeModal';
import { FEATURE_REGISTRY, getFeature, type FeatureId } from './feature-registry';
import { closureToEnable } from './modules-graph';
import { useFeature } from './useFeature';

export interface ModuleGuardProps {
  /** The feature this route belongs to; sourced from the registry (`featureForRoute`). */
  readonly feature: FeatureId;
  /** The real screen to render when the feature is on (or the user continues anyway). */
  readonly children: ReactNode;
}

/**
 * Gate an optional page route behind its feature. Transparent when the feature is on;
 * otherwise renders the "module hidden" interstitial in place.
 */
export function ModuleGuard({ feature, children }: ModuleGuardProps) {
  const enabled = useFeature(feature);
  // A one-shot "Continue anyway" override — renders the real screen without changing intent.
  const [override, setOverride] = useState(false);

  if (enabled || override) return <>{children}</>;
  return <ModuleHiddenInterstitial feature={feature} onContinue={() => setOverride(true)} />;
}

/** The in-place "this module is hidden" screen with Show / Continue affordances. */
function ModuleHiddenInterstitial({
  feature,
  onContinue,
}: {
  readonly feature: FeatureId;
  readonly onContinue: () => void;
}) {
  const intent = useModulesStore((state) => state.intent);
  const setFeatureIntent = useModulesStore((state) => state.setFeatureIntent);
  const [pending, setPending] = useState<PendingCascade | null>(null);
  /**
   * Switching a module back on is a write to the module list, and this interstitial is a second
   * door onto it — the Modules screen is not the only way in (issue #429). A role that may not
   * edit the list is offered "Continue anyway" instead, which changes nothing.
   */
  const mayWriteModules = usePermission('modules:write');
  /** Whether the footer's shortcut into the manager leads anywhere for this role. */
  const mayReachModules = usePermission(ROUTE_PERMISSIONS.get('/modules'));

  const def = getFeature(feature);
  // Defensive: an unregistered id can't reach here (the prop is a FeatureId), but never crash.
  if (!def) return null;

  /**
   * Turn the module back on. If it depends on features that are currently off, confirm the
   * pulled-in switches first (matching the Modules screen); otherwise flip it on directly.
   */
  const showModule = () => {
    if (!mayWriteModules) return;
    const closure = [...closureToEnable(feature, intent, FEATURE_REGISTRY)];
    if (closure.some((id) => id !== feature)) {
      setPending({ action: 'enable', id: feature, closure });
      return;
    }
    setFeatureIntent(feature, true);
  };

  const confirmEnable = () => {
    if (!pending || !mayWriteModules) return;
    // Enabling must switch every pulled-in dependency on, or the feature still resolves off.
    for (const id of pending.closure) setFeatureIntent(id, true);
    setPending(null);
  };

  return (
    <PageContainer>
      <PageHeader icon={<def.Icon />} title={def.label} />

      <Interstitial
        icon={<HideIcon />}
        heading={`${def.label} is hidden`}
        body={[
          def.description,
          'You’ve switched this module off for a leaner app. Your data is untouched — switch it back on whenever you like.',
        ]}
        actions={
          <>
            {mayWriteModules ? (
              <Button data-testid="module-guard-show" onClick={showModule}>
                <ShowIcon aria-hidden />
                Show this module
              </Button>
            ) : null}
            <Button variant="outline" data-testid="module-guard-continue" onClick={onContinue}>
              Continue anyway
            </Button>
          </>
        }
        footer={
          mayReachModules ? (
            <Link to="/modules" className={cn(buttonVariants({ variant: 'link' }), 'h-auto px-0')}>
              <ModulesIcon aria-hidden />
              Manage modules
            </Link>
          ) : null
        }
      />

      {pending ? (
        <ConfirmCascadeModal pending={pending} onCancel={() => setPending(null)} onConfirm={confirmEnable} />
      ) : null}
    </PageContainer>
  );
}
