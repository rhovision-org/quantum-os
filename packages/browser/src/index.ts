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
  QOS_ABI_VERSION, QOS_ALL_RIGHTS, QOS_RIGHTS, QOS_SIGNALS, QOS_SYSCALLS, QosKernel, replayQosKernel,
} from "./qos-kernel.js";
export type {
  QosErrno, QosHandle, QosHandleInfo, QosProcess, QosProcessInfo, QosProcessState,
  QosResult, QosRightName, QosSignal, QosSyscallName, QosKernelReplayResult,
} from "./qos-kernel.js";

// Personal success-framework goals — identity-scoped, local-only by default.
export { GoalStore, GOAL_PRIORITIES, parseGoalAdd } from "./goal-store.js";
export type {
  Goal, GoalPriority, GoalStatus, GoalStorage, SharedGoal,
} from "./goal-store.js";

// Canonical group charter artifact for the required RhoGov/Rholo handoff.
export {
  SUCCESS_CHARTER_SCHEMA, SUCCESS_CHARTER_VERSION,
  buildSuccessCharter, successCharterHash, validateSuccessCharter,
} from "./success-charter.js";
export type {
  CharterDecision, CharterGroup, CharterMember, CharterObjective, CharterRole,
  CharterValidation, CharterValidationOptions, SuccessCharter, SuccessCharterInput,
} from "./success-charter.js";

// RhoQu success recipes using only the shipped subset (see #290 for gaps).
export { SUCCESS_RECIPES, recipeById } from "./success-recipes.js";
export type { SuccessRecipe } from "./success-recipes.js";
