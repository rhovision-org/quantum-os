import { loadZfa, generateCapability } from "./zfa.js";
import { QOSPeer } from "./peer.js";

export { QOSPeer, generateCapability, loadZfa };
export type { PeerConfig } from "./peer.js";

// QOS process orchestration (gate quantum-os#264): the finite event contract,
// the verification log, the deterministic reducer, and the room adapter.
export {
  QOS_EVENT_SCHEMA,
  QOS_EVENT_TYPES,
  QosEventLog,
  QosEventSigner,
  QosProcessRoom,
  attenuateScope,
  brokenChainsIn,
  canonicalEvents,
  canonicalJson,
  compareEvents,
  compareStrings,
  concatZfa,
  decodeQosEvent,
  deriveProcessCapability,
  isCapabilityAttenuated,
  mergeEventLogs,
  newParticipantScope,
  newRootScope,
  optionId,
  orchestrate,
  parseQosEvent,
  processIdFor,
  scopeAllows,
  sha256Hex,
  validateQosEventShape,
  zfaHistoryAchievesZfa,
} from "./qos-process.js";
export type {
  EventShapeResult,
  IngestResult,
  QosCapabilityScope,
  QosEvent,
  QosEventType,
  QosProcessRoomConfig,
  QosProcessStartOptions,
  QosProcessView,
  QosQuorum,
  QosTransport,
} from "./qos-process.js";
