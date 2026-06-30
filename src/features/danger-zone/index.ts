/**
 * Danger-Zone data-layer engine barrel (spec §3 Settings — "Erase my data").
 *
 * Exposes ONLY the pure catalog + executor API the UI codes against. No components live here:
 * the Danger-Zone screen imports the engine, never the other way round.
 */
export {
  ERASE_SECTIONS,
  ERASE_TARGETS,
  eraseTargetById,
  type EraseSection,
  type EraseTarget,
  type EraseTargetId,
} from './erase-targets';

export {
  browserErasePorts,
  countTargets,
  eraseTargets,
  type ErasePorts,
  type EraseSummary,
} from './erase-actions';
