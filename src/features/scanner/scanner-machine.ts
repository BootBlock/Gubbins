/**
 * The mobile scanner state machine (spec §6.2, Phase 6).
 *
 * A discrete reducer governs the camera lifecycle so we never end up with the
 * conflicting boolean flags (`isScanning` + `isLoading`) §6.2 warns against. The
 * reducer is pure and exhaustively unit-tested; the React component wires real
 * `getUserMedia` / Visibility-API / unmount effects to dispatch into it.
 *
 *   IDLE → REQUESTING_PERMISSIONS → STREAM_ACTIVE ⇄ PROCESSING_QUEUE
 *   (REQUESTING/STREAM failures → ERROR_STATE: denied / unsupported / stream failure)
 *
 * `SUSPEND` (document hidden, §6.1) tears the stream down to IDLE to save battery;
 * the component re-OPENs on return. `REOPEN` re-enters REQUESTING_PERMISSIONS from the
 * live view so a different camera can be swapped in (issue #135) without a second
 * acquisition path. `mode` (Discrete vs Continuous, §6.3) is part of the state but
 * orthogonal to the lifecycle, so it can change at any time.
 */

export type ScannerStatus =
  'IDLE' | 'REQUESTING_PERMISSIONS' | 'STREAM_ACTIVE' | 'PROCESSING_QUEUE' | 'ERROR_STATE';

/** Discrete = scan one then act; Continuous = batch to a working queue (§6.3). */
export type ScannerMode = 'DISCRETE' | 'CONTINUOUS';

export interface ScannerState {
  readonly status: ScannerStatus;
  readonly mode: ScannerMode;
  /** Human-readable failure reason when `status === 'ERROR_STATE'`, else null. */
  readonly error: string | null;
}

export type ScannerAction =
  | { type: 'OPEN' }
  /**
   * Re-acquire the camera while the scanner is already up — the user picked a different camera
   * (issue #135). Routing it back through `REQUESTING_PERMISSIONS` keeps one acquisition path, so
   * a camera that refuses to open fails in exactly the same place a first open would.
   */
  | { type: 'REOPEN' }
  | { type: 'PERMISSION_GRANTED' }
  | { type: 'PERMISSION_DENIED'; message?: string }
  | { type: 'STREAM_ERROR'; message?: string }
  | { type: 'REVIEW_QUEUE' }
  | { type: 'RESUME_SCANNING' }
  | { type: 'SUSPEND' }
  | { type: 'CLOSE' }
  | { type: 'SET_MODE'; mode: ScannerMode };

export function initialScannerState(mode: ScannerMode = 'DISCRETE'): ScannerState {
  return { status: 'IDLE', mode, error: null };
}

export function scannerReducer(state: ScannerState, action: ScannerAction): ScannerState {
  switch (action.type) {
    case 'SET_MODE':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };

    case 'CLOSE':
      // Closing the overlay is always valid and returns to rest, clearing errors.
      return { ...state, status: 'IDLE', error: null };

    case 'SUSPEND':
      // Backgrounded: the component stops the track; we drop to IDLE so the next
      // foreground OPEN re-requests cleanly (§6.1). A no-op from IDLE/ERROR.
      if (state.status === 'IDLE' || state.status === 'ERROR_STATE') return state;
      return { ...state, status: 'IDLE' };

    case 'OPEN':
      // Begin (or retry from an error) the permission request.
      if (state.status === 'IDLE' || state.status === 'ERROR_STATE') {
        return { ...state, status: 'REQUESTING_PERMISSIONS', error: null };
      }
      return state;

    case 'REOPEN':
      // Swap to a different camera without leaving the scanner. Only valid from the live view (the
      // only state that offers the camera menu): from IDLE/ERROR the way back in is OPEN, and from
      // PROCESSING_QUEUE it would discard the batch-review pane the user is standing in.
      return state.status === 'STREAM_ACTIVE'
        ? { ...state, status: 'REQUESTING_PERMISSIONS', error: null }
        : state;

    case 'PERMISSION_GRANTED':
      return state.status === 'REQUESTING_PERMISSIONS'
        ? { ...state, status: 'STREAM_ACTIVE', error: null }
        : state;

    case 'PERMISSION_DENIED':
      return {
        ...state,
        status: 'ERROR_STATE',
        error: action.message ?? 'Camera permission was denied.',
      };

    case 'STREAM_ERROR':
      return {
        ...state,
        status: 'ERROR_STATE',
        error: action.message ?? 'The camera stream could not be started.',
      };

    case 'REVIEW_QUEUE':
      // Pause the live view to review a batch (Continuous Mode, §6.3).
      return state.status === 'STREAM_ACTIVE' ? { ...state, status: 'PROCESSING_QUEUE' } : state;

    case 'RESUME_SCANNING':
      // Back to the live viewfinder from the review pane.
      return state.status === 'PROCESSING_QUEUE' ? { ...state, status: 'STREAM_ACTIVE' } : state;

    default:
      return state;
  }
}

/**
 * True when the camera track should be live for this status.
 *
 * @internal Exported for unit tests only.
 */
export function isStreaming(status: ScannerStatus): boolean {
  return status === 'STREAM_ACTIVE';
}
