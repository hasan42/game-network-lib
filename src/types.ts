/**
 * game-network-lib — Real-time multiplayer networking for games
 *
 * Architecture:
 * - Host is authoritative — owns game state, broadcasts to guests
 * - Guests send actions → host applies them
 * - Supports PeerJS (P2P, 2 players) and Firebase (N players, real-time)
 */

// ─── Generic Types ───

/** Any serializable game state */
export type AnyGameState = Record<string, unknown>;

/** Any serializable game action */
export type AnyGameAction = { type: string; [key: string]: unknown };

/** Network role */
export type NetworkRole = 'host' | 'guest';

/** Network event */
export interface NetworkEvent {
  type: 'connected' | 'disconnected' | 'data' | 'error';
  payload?: unknown;
}

/** Network backend type */
export type NetworkBackend = 'peerjs' | 'firebase';

/** Callback for receiving game state */
export type OnStateCallback = (state: AnyGameState, myPlayerIndex: number) => void;

/** Callback for receiving an action (host only) */
export type OnActionCallback = (action: AnyGameAction & { playerIndex: number }) => void;

/** Callback for connection/disconnection events */
export type OnConnectionCallback = (connected: boolean, role: NetworkRole | null) => void;

/** Callback for errors */
export type OnErrorCallback = (error: string) => void;

// ─── Network Manager Interface ───

/**
 * Abstract network manager — PeerJS and Firebase implement this interface.
 * Use this as the dependency-injection point in your game code.
 */
export interface NetworkManagerInterface {
  readonly role: NetworkRole | null;
  readonly connected: boolean;

  /** Host: create a room. Returns room ID. */
  host(options?: Record<string, unknown>): Promise<string>;

  /** Guest: join a room */
  join(roomId: string, options?: Record<string, unknown>): Promise<void>;

  /** Send data through the network */
  send(data: unknown): boolean;

  /** Disconnect and clean up */
  disconnect(): void;

  /** Subscribe to all events */
  on(listener: (event: NetworkEvent) => void): () => void;

  /** Subscribe to data events only */
  onData(callback: (data: unknown) => void): () => void;
}

// ─── Game Network Client ───

export interface GameNetworkConfig {
  /** Which backend to use */
  backend: NetworkBackend;
  /** Called on host when a guest sends an action */
  onAction?: OnActionCallback;
  /** Called on guest when host broadcasts a state update */
  onState?: OnStateCallback;
  /** Called when connection status changes */
  onConnectionChange?: OnConnectionCallback;
  /** Called on network error */
  onError?: OnErrorCallback;
}

export interface GameNetworkStatus {
  backend: NetworkBackend;
  role: NetworkRole | null;
  myPlayerIndex: number;
  connected: boolean;
  error: string | null;
  roomId: string | null;
}

/**
 * GameNetwork — high-level API for multiplayer games.
 *
 * Wraps a NetworkManagerInterface and provides:
 * - Host-authoritative state broadcasting
 * - Action routing (guest → host)
 * - Clean connection lifecycle
 */
export class GameNetwork {
  private network: NetworkManagerInterface | null = null;
  private config: GameNetworkConfig;
  private _status: GameNetworkStatus;

  constructor(config: GameNetworkConfig) {
    this.config = config;
    this._status = {
      backend: config.backend,
      role: null,
      myPlayerIndex: -1,
      connected: false,
      error: null,
      roomId: null,
    };
  }

  get status(): GameNetworkStatus {
    return { ...this._status };
  }

  /** Initialize as host */
  async initHost(network: NetworkManagerInterface): Promise<string> {
    this.network = network;
    const roomId = await network.host();

    network.onData((data) => {
      const msg = data as { type: string; action?: AnyGameAction; playerIndex?: number };
      if (msg.type === 'action' && msg.action) {
        const playerIndex = msg.playerIndex ?? (msg.action as any).playerIndex ?? -1;
        const innerAction = (msg.action as { action?: AnyGameAction }).action ?? msg.action;
        this.config.onAction?.({ ...innerAction, playerIndex });
      }
    });

    network.on((event) => {
      if (event.type === 'disconnected') {
        this._status.connected = false;
        this.config.onConnectionChange?.(false, this._status.role);
      }
      if (event.type === 'error') {
        this._status.error = String(event.payload ?? 'Network error');
        this.config.onError?.(this._status.error);
      }
    });

    this._status = {
      ...this._status,
      role: 'host',
      myPlayerIndex: 0,
      connected: true,
      error: null,
      roomId,
    };
    this.config.onConnectionChange?.(true, 'host');

    return roomId;
  }

  /** Initialize as guest */
  async initGuest(network: NetworkManagerInterface, playerIndex?: number): Promise<void> {
    this.network = network;
    await network.join('');

    const myIndex = playerIndex ?? 1;

    network.onData((data) => {
      const msg = data as { type: string; state?: AnyGameState; myPlayerIndex?: number };
      if (msg.type === 'full_state' && msg.state) {
        const idx = msg.myPlayerIndex ?? myIndex;
        this._status.myPlayerIndex = idx;
        this.config.onState?.(msg.state, idx);
      }
    });

    network.on((event) => {
      if (event.type === 'disconnected') {
        this._status.connected = false;
        this.config.onConnectionChange?.(false, this._status.role);
      }
      if (event.type === 'error') {
        this._status.error = String(event.payload ?? 'Network error');
        this.config.onError?.(this._status.error);
      }
    });

    this._status = {
      ...this._status,
      role: 'guest',
      myPlayerIndex: myIndex,
      connected: true,
      error: null,
      roomId: 'roomId' in network ? (network as any).roomId : null,
    };
    this.config.onConnectionChange?.(true, 'guest');
  }

  /** Send an action (guest → host) */
  sendAction(action: AnyGameAction): boolean {
    if (!this.network) return false;
    return this.network.send({ type: 'action', action });
  }

  /** Broadcast game state (host → guests) */
  broadcastState(state: AnyGameState): boolean {
    if (!this.network) return false;
    return this.network.send({ type: 'full_state', state });
  }

  /** Disconnect */
  disconnect(): void {
    this.network?.disconnect();
    this.network = null;
    this._status = {
      ...this._status,
      role: null,
      myPlayerIndex: -1,
      connected: false,
      error: null,
      roomId: null,
    };
    this.config.onConnectionChange?.(false, null);
  }
}

// ─── Firebase Helpers ───

export interface FirestoreRoom {
  id: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  status: 'waiting' | 'playing' | 'finished';
  gameState?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface FirestorePlayer {
  id: string;
  name: string;
  roomId: string;
  index: number;
  connected: boolean;
  lastSeen: unknown;
}

// ─── Serialization ───

/**
 * Strip functions from a Zustand store snapshot.
 * Firebase/JSON can't serialize functions, so this extracts only data fields.
 */
export function serializeState<T extends Record<string, unknown>>(
  store: T,
  excludeKeys: string[] = []
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === 'function' || excludeKeys.includes(key)) continue;
    result[key] = value;
  }
  return result;
}