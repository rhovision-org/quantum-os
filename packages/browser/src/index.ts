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

// The room-facing `/qos` command surface over the contract above.
export { QosCommand } from "./qos-command.js";
export type { QosCommandHost } from "./qos-command.js";

// QOS/1 kernel ABI v0 — pure capability-handle/process model (docs/os-abi.md).
export {
  QOS_ABI_VERSION, QOS_ALL_RIGHTS, QOS_RIGHTS, QOS_SIGNALS, QOS_SYSCALLS, QosKernel,
} from "./qos-kernel.js";
export type {
  QosErrno, QosHandle, QosHandleInfo, QosProcess, QosProcessInfo, QosProcessState,
  QosResult, QosRightName, QosSignal, QosSyscallName,
} from "./qos-kernel.js";
