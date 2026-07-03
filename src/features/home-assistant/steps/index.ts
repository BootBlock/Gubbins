import type { ComponentType } from 'react';
import type { GuideStepId } from '../guide';
import { OverviewStep } from './OverviewStep';
import { TokenStep } from './TokenStep';
import { BridgeStep } from './BridgeStep';
import { DataStep } from './DataStep';
import { IntegrationStep } from './IntegrationStep';
import { ConfigureStep } from './ConfigureStep';
import { SentencesStep } from './SentencesStep';
import { FinishStep } from './FinishStep';

/**
 * Registry mapping each step id to its content component. Kept beside the step components (not
 * in the pure `guide.ts` metadata) so `guide.ts` stays free of JSX and trivially unit-testable.
 */
export const STEP_COMPONENTS: Record<GuideStepId, ComponentType> = {
  overview: OverviewStep,
  token: TokenStep,
  bridge: BridgeStep,
  data: DataStep,
  integration: IntegrationStep,
  configure: ConfigureStep,
  sentences: SentencesStep,
  finish: FinishStep,
};
