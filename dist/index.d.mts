/**
 * game-network-lib — Real-time multiplayer networking for games
 *
 * Architecture:
 * - Host is authoritative — owns game state, broadcasts to guests
 * - Guests send actions → host applies them
 * - Supports PeerJS (P2P, 2 players) and Firebase (N players, real-time)
 */
/** Any serializable game state */
type AnyGameState = Record<string, unknown>;
/** Any serializable game action */
type AnyGameAction = {
    type: string;
    [key: string]: unknown;
};
/** Network role */
type NetworkRole = 'host' | 'guest';
/** Network event */
interface NetworkEvent {
    type: 'connected' | 'disconnected' | 'data' | 'error';
    payload?: unknown;
}
/** Network backend type */
type NetworkBackend = 'peerjs' | 'firebase';
/** Callback for receiving game state */
type OnStateCallback<S extends AnyGameState> = (state: S, myPlayerIndex: number) => void;
/** Callback for receiving an action (host only) */
type OnActionCallback<A extends AnyGameAction> = (action: A & {
    playerIndex: number;
}) => void;
/** Callback for connection/disconnection events */
type OnConnectionCallback = (connected: boolean, role: NetworkRole | null) => void;
/** Callback for errors */
type OnErrorCallback = (error: string) => void;
/**
 * Abstract network manager — PeerJS and Firebase implement this interface.
 * Use this as the dependency-injection point in your game code.
 */
interface NetworkManagerInterface {
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
interface GameNetworkConfig<S extends AnyGameState, A extends AnyGameAction> {
    /** Which backend to use */
    backend: NetworkBackend;
    /** Called on host when a guest sends an action */
    onAction?: OnActionCallback<A>;
    /** Called on guest when host broadcasts a state update */
    onState?: OnStateCallback<S>;
    /** Called when connection status changes */
    onConnectionChange?: OnConnectionCallback;
    /** Called on network error */
    onError?: OnErrorCallback;
}
interface GameNetworkStatus {
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
declare class GameNetwork<S extends AnyGameState, A extends AnyGameAction> {
    private network;
    private config;
    private _status;
    constructor(config: GameNetworkConfig<S, A>);
    get status(): GameNetworkStatus;
    /** Initialize as host */
    initHost(network: NetworkManagerInterface): Promise<string>;
    /** Initialize as guest */
    initGuest(network: NetworkManagerInterface, playerIndex?: number): Promise<void>;
    /** Send an action (guest → host) */
    sendAction(action: A): boolean;
    /** Broadcast game state (host → guests) */
    broadcastState(state: S): boolean;
    /** Disconnect */
    disconnect(): void;
}
/**
 * Firebase room document structure.
 * Used by FirebaseNetworkManager — you can import this for type-safe room access.
 */
interface FirestoreRoom {
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
interface FirestorePlayer {
    id: string;
    name: string;
    roomId: string;
    index: number;
    connected: boolean;
    lastSeen: unknown;
}
/**
 * Strip functions from a Zustand store snapshot.
 * Firebase/JSON can't serialize functions, so this extracts only data fields.
 */
declare function serializeState<T extends Record<string, unknown>>(store: T, excludeKeys?: string[]): Record<string, unknown>;

/**
 * PeerJS Network Manager
 *
 * P2P through WebRTC with a PeerJS signaling server.
 * Best for 2-player games on the same network or with STUN/TURN.
 *
 * Usage:
 *   const nm = new PeerJSNetworkManager({ host: 'localhost', port: 9000, path: '/myapp' });
 *   const roomId = await nm.host();  // or nm.join(roomId)
 */

interface PeerJSConfig {
    /** PeerJS server host */
    host: string;
    /** PeerJS server port */
    port: number;
    /** PeerJS server path */
    path: string;
    /** Use secure connection (wss) */
    secure?: boolean;
    /** STUN/TURN servers */
    iceServers?: Array<{
        urls: string;
    }>;
}
type Listener$1 = (event: NetworkEvent) => void;
declare class PeerJSNetworkManager implements NetworkManagerInterface {
    private peer;
    private connection;
    private myId;
    private _isHost;
    private _role;
    private listeners;
    private config;
    constructor(config: PeerJSConfig);
    private getPeerOptions;
    on(listener: Listener$1): () => void;
    onData(callback: (data: unknown) => void): () => void;
    private emit;
    host(options?: Record<string, unknown>): Promise<string>;
    join(roomId: string): Promise<void>;
    private setupConnection;
    send(data: unknown): boolean;
    disconnect(): void;
    get role(): NetworkRole | null;
    get connected(): boolean;
    get roomId(): string;
}

/**
 * Firebase Network Manager
 *
 * Real-time multiplayer via Firestore.
 * Host-authoritative: host writes gameState, guests send actions.
 * Supports 2-6 players, auto-reconnect, heartbeat.
 *
 * Usage:
 *   const nm = new FirebaseNetworkManager(firebaseConfig);
 *   const roomId = await nm.host();  // or nm.join(roomId, 'Player 2')
 */

interface FirebaseConfig {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
}
type Listener = (event: NetworkEvent) => void;
declare class FirebaseNetworkManager implements NetworkManagerInterface {
    private _roomId;
    private myId;
    private _role;
    private _playerIndex;
    private _isHost;
    private _connected;
    private listeners;
    private unsubscribeRoom;
    private unsubscribePlayers;
    private unsubscribeActions;
    private _players;
    private heartbeatInterval;
    private firebaseConfig;
    private _app;
    private _db;
    constructor(config: FirebaseConfig);
    private getDb;
    on(listener: Listener): () => void;
    onData(callback: (data: unknown) => void): () => void;
    private emit;
    host(options?: Record<string, unknown>): Promise<string>;
    join(roomId: string, options?: Record<string, unknown>): Promise<void>;
    disconnect(): void;
    send(data: any): boolean;
    get role(): NetworkRole | null;
    get connected(): boolean;
    get roomId(): string;
    get playerIndex(): number;
    get playerList(): FirestorePlayer[];
    private updateGameState;
    private sendAction;
    private leaveRoom;
    private startSubscriptions;
    private startActionListener;
    private stopSubscriptions;
    private startHeartbeat;
    private stopHeartbeat;
    private generateRoomId;
    private generatePlayerId;
}

export { type FirebaseConfig, FirebaseNetworkManager, type FirestorePlayer, type FirestoreRoom, type AnyGameAction as GameAction, GameNetwork, type GameNetworkConfig, type GameNetworkStatus, type AnyGameState as GameState, type NetworkBackend, type NetworkEvent, type NetworkManagerInterface, type NetworkRole, type OnActionCallback, type OnConnectionCallback, type OnErrorCallback, type OnStateCallback, type PeerJSConfig, PeerJSNetworkManager, serializeState };
