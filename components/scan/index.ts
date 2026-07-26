/** Public surface of the live-camera monument scanner. */

export { default as ScanClient, type ScanClientProps } from './ScanClient';

export {
  useScan,
  SAMPLE_INTERVAL_MS,
  GATE_RETRY_MS,
  MAX_CALLS_PER_RUN,
  MAX_CALLS_PER_PAGE,
  CONFIRM_MS,
  type ScanControls,
  type ScanPhase,
  type StopReason,
  type Candidate,
} from './useScan';

export { useCamera, type CameraState, type CameraStatus } from './useCamera';

export {
  analyseFrame,
  captureStill,
  createScratch,
  encodeFrame,
  frameReady,
  gate,
  meanAbsDiff,
  verdictCopy,
  BLUR_MIN_VARIANCE,
  BRIGHT_MEAN_LUMA,
  DARK_MEAN_LUMA,
  DEDUP_MAD,
  SAMPLE_EDGE,
  SAMPLE_QUALITY,
  type FrameStats,
  type FrameVerdict,
  type FrameScratch,
} from './frame';

export { identifyFrame, type ScanOutcome, type ScanConfidence } from './scanIdentify';
export { prepareUngroundedPhotograph, type HandoffOutcome } from './handoff';
