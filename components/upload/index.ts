/** Public surface of the "talk to your own photograph" lane. */

export { default as PhotoIntake, type PhotoIntakeProps } from './PhotoIntake';
export { default as PhotoConversation, type PhotoConversationProps } from './PhotoConversation';
export { default as UngroundedBadge, type UngroundedBadgeProps } from './UngroundedBadge';

export { computeDepthAndRegions, phaseCopy, type DepthOutcome } from './depthRegions';
export {
  hashBlob,
  savePhoto,
  loadPhoto,
  loadLatestPhoto,
  listPhotos,
  deletePhoto,
  clearPhotos,
  type StoredPhoto,
} from './photoStore';
export { identifyPhoto, type IdentifyOutcome } from './identify';
