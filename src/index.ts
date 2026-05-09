/**
 * game-network-lib — Real-time multiplayer networking for games
 *
 * Main entry point. Import from here:
 *   import { GameNetwork, PeerJSNetworkManager, FirebaseNetworkManager } from 'game-network-lib';
 */

export {
  GameNetwork,
  serializeState,
} from './types';

export type {
  AnyGameState,
  AnyGameAction,
  NetworkRole,
  NetworkEvent,
  NetworkBackend,
  NetworkManagerInterface,
  FirestoreRoom,
  FirestorePlayer,
  OnStateCallback,
  OnActionCallback,
  OnConnectionCallback,
  OnErrorCallback,
  GameNetworkConfig,
  GameNetworkStatus,
} from './types';

export { PeerJSNetworkManager } from './peerjs';
export type { PeerJSConfig } from './peerjs';

export { FirebaseNetworkManager } from './firebase';
export type { FirebaseConfig } from './firebase';