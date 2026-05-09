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

import type { NetworkManagerInterface, NetworkRole, NetworkEvent, FirestoreRoom, FirestorePlayer } from './types';

// ─── Firebase Config ───

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

type Listener = (event: NetworkEvent) => void;

// ─── Firebase Network Manager ───

export class FirebaseNetworkManager implements NetworkManagerInterface {
  private _roomId: string = '';
  private myId: string = '';
  private _role: NetworkRole | null = null;
  private _playerIndex: number = -1;
  private _isHost: boolean = false;
  private _connected: boolean = false;
  private listeners: Listener[] = [];
  private unsubscribeRoom: (() => void) | null = null;
  private unsubscribePlayers: (() => void) | null = null;
  private unsubscribeActions: (() => void) | null = null;
  private _players: FirestorePlayer[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private firebaseConfig: FirebaseConfig;

  // Lazy-loaded Firebase instances
  private _app: any = null;
  private _db: any = null;

  constructor(config: FirebaseConfig) {
    this.firebaseConfig = config;
  }

  // ─── Firebase Init (lazy) ───

  private async getDb(): Promise<any> {
    if (!this._db) {
      const { initializeApp } = await import('firebase/app');
      const { getFirestore } = await import('firebase/firestore');
      this._app = initializeApp(this.firebaseConfig);
      this._db = getFirestore(this._app);
    }
    return this._db;
  }

  // ─── EventEmitter ───

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  onData(callback: (data: unknown) => void): () => void {
    return this.on((event) => {
      if (event.type === 'data') {
        callback(event.payload);
      }
    });
  }

  private emit(event: NetworkEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[FirebaseNetwork] Listener error:', e);
      }
    }
  }

  // ─── Connection ───

  async host(options?: Record<string, unknown>): Promise<string> {
    const db = await this.getDb();
    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');

    const maxPlayers = (options?.maxPlayers as number) ?? 2;
    const hostName = (options?.hostName as string) ?? 'Host';
    const roomId = this.generateRoomId();
    const hostId = this.generatePlayerId();

    this._roomId = roomId;
    this.myId = hostId;
    this._isHost = true;
    this._role = 'host';
    this._playerIndex = 0;

    // Create room
    const roomRef = doc(db, 'game_rooms', roomId);
    await setDoc(roomRef, {
      id: roomId,
      hostId,
      hostName,
      playerCount: 1,
      maxPlayers,
      status: 'waiting',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Register host as player
    const playerRef = doc(db, 'game_rooms', roomId, 'players', hostId);
    await setDoc(playerRef, {
      id: hostId,
      name: 'Host',
      roomId,
      index: 0,
      connected: true,
      lastSeen: serverTimestamp(),
    });

    this.startHeartbeat(db);
    this.startSubscriptions(db);
    this._connected = true;
    this.emit({ type: 'connected', payload: { role: 'host', roomId } });

    return roomId;
  }

  async join(roomId: string, options?: Record<string, unknown>): Promise<void> {
    const db = await this.getDb();
    const { doc, getDoc, setDoc, updateDoc, serverTimestamp } = await import('firebase/firestore');

    const playerName = (options?.playerName as string) ?? 'Guest';
    const playerIndex = options?.playerIndex as number | undefined;
    const playerId = options?.playerId as string | undefined;

    // Check room exists
    const roomRef = doc(db, 'game_rooms', roomId);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) {
      throw new Error('Room not found');
    }

    const room = roomSnap.data() as FirestoreRoom;

    // Reconnect: if playerId is provided and already in the room, just re-subscribe
    if (playerId && playerIndex !== undefined) {
      // Update player as connected
      const existingPlayerRef = doc(db, 'game_rooms', roomId, 'players', playerId);
      await setDoc(existingPlayerRef, {
        id: playerId,
        name: `${playerName} ${playerIndex + 1}`,
        roomId,
        index: playerIndex,
        connected: true,
        lastSeen: serverTimestamp(),
      }, { merge: true });

      this._roomId = roomId;
      this.myId = playerId;
      this._isHost = false;
      this._role = 'guest';
      this._playerIndex = playerIndex;

      this.startHeartbeat(db);
      this.startSubscriptions(db);
      this._connected = true;
      this.emit({ type: 'connected', payload: { role: 'guest', roomId } });
      return;
    }

    if (room.status !== 'waiting') {
      throw new Error('Room is not accepting players');
    }
    if (room.playerCount >= room.maxPlayers) {
      throw new Error('Room is full');
    }

    const newPlayerIndex = room.playerCount; // 0-based: host=0, first guest=1, etc.

    // Add player
    const newPlayerId = this.generatePlayerId();
    const playerRef = doc(db, 'game_rooms', roomId, 'players', newPlayerId);
    await setDoc(playerRef, {
      id: newPlayerId,
      name: `${playerName} ${newPlayerIndex + 1}`,
      roomId,
      index: newPlayerIndex,
      connected: true,
      lastSeen: serverTimestamp(),
    });

    // Update player count
    await updateDoc(roomRef, {
      playerCount: room.playerCount + 1,
      updatedAt: serverTimestamp(),
    });

    this._roomId = roomId;
    this.myId = newPlayerId;
    this._isHost = false;
    this._role = 'guest';
    this._playerIndex = newPlayerIndex;

    this.startHeartbeat(db);
    this.startSubscriptions(db);
    this._connected = true;
    this.emit({ type: 'connected', payload: { role: 'guest', roomId } });
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.stopSubscriptions();

    if (this._roomId && this.myId) {
      this.leaveRoom().catch(console.error);
    }

    this._roomId = '';
    this.myId = '';
    this._isHost = false;
    this._role = null;
    this._playerIndex = -1;
    this._connected = false;
    this._players = [];
    this.listeners = [];
  }

  send(data: any): boolean {
    if (!this._connected || !this._roomId) {
      console.warn('[FirebaseNetwork] Not connected, cannot send');
      return false;
    }

    // Host: update gameState in Firestore
    if (this._isHost && data.type === 'full_state') {
      this.updateGameState(data.state).catch((e: Error) => {
        console.error('[FirebaseNetwork] Failed to update gameState:', e);
      });
      return true;
    }

    // Guest: write action to actions subcollection
    if (!this._isHost) {
      this.sendAction(data).catch(console.error);
      return true;
    }

    return false;
  }

  // ─── Getters ───

  get role(): NetworkRole | null { return this._role; }
  get connected(): boolean { return this._connected; }
  get roomId(): string { return this._roomId; }
  get playerIndex(): number { return this._playerIndex; }
  get playerList(): FirestorePlayer[] { return this._players; }

  // ─── Private: Firestore operations ───

  private async updateGameState(gameState: unknown): Promise<void> {
    const db = await this.getDb();
    const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore');
    await updateDoc(doc(db, 'game_rooms', this._roomId), {
      gameState,
      updatedAt: serverTimestamp(),
    });
  }

  private async sendAction(data: any): Promise<void> {
    const db = await this.getDb();
    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
    await setDoc(doc(db, 'game_rooms', this._roomId, 'actions', `${Date.now()}_${this.myId}`), {
      ...data,
      playerId: this.myId,
      playerIndex: this._playerIndex,
      timestamp: serverTimestamp(),
    });
  }

  private async leaveRoom(): Promise<void> {
    const db = await this.getDb();
    const { doc, deleteDoc, getDoc, updateDoc, serverTimestamp } = await import('firebase/firestore');

    await deleteDoc(doc(db, 'game_rooms', this._roomId, 'players', this.myId));

    const roomRef = doc(db, 'game_rooms', this._roomId);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) return;

    const room = roomSnap.data() as FirestoreRoom;
    const newCount = Math.max(0, room.playerCount - 1);

    if (newCount === 0) {
      await deleteDoc(roomRef);
    } else {
      await updateDoc(roomRef, {
        playerCount: newCount,
        updatedAt: serverTimestamp(),
      });
    }
  }

  // ─── Subscriptions ───

  private startSubscriptions(db: any): void {
    import('firebase/firestore').then(({ doc, onSnapshot, collection }) => {
      // Subscribe to room
      this.unsubscribeRoom = onSnapshot(doc(db, 'game_rooms', this._roomId), (snap: any) => {
        if (!snap.exists()) {
          this.emit({ type: 'disconnected' });
          return;
        }
        const room = snap.data();

        // Guest receives gameState
        if (!this._isHost && room.gameState) {
          this.emit({ type: 'data', payload: { type: 'full_state', state: room.gameState, myPlayerIndex: this._playerIndex } });
        }
      });

      // Subscribe to players
      this.unsubscribePlayers = onSnapshot(collection(db, 'game_rooms', this._roomId, 'players'), (snap: any) => {
        this._players = [];
        snap.forEach((d: any) => {
          this._players.push(d.data() as FirestorePlayer);
        });
      });

      // Host subscribes to actions
      if (this._isHost) {
        this.startActionListener(db);
      }
    });
  }

  private startActionListener(db: any): void {
    import('firebase/firestore').then(({ collection, onSnapshot, deleteDoc, doc, query, orderBy }) => {
      const actionsRef = collection(db, 'game_rooms', this._roomId, 'actions');
      const q = query(actionsRef, orderBy('timestamp'));

      this.unsubscribeActions = onSnapshot(q, (snap: any) => {
        snap.docChanges().forEach((change: any) => {
          if (change.type === 'added') {
            const action = change.doc.data();
            this.emit({ type: 'data', payload: { type: 'action', action } });
            // Delete processed action
            deleteDoc(doc(db, 'game_rooms', this._roomId, 'actions', change.doc.id)).catch(() => {});
          }
        });
      });
    });
  }

  private stopSubscriptions(): void {
    this.unsubscribeRoom?.();
    this.unsubscribeRoom = null;
    this.unsubscribePlayers?.();
    this.unsubscribePlayers = null;
    this.unsubscribeActions?.();
    this.unsubscribeActions = null;
  }

  // ─── Heartbeat ───

  private startHeartbeat(db: any): void {
    this.heartbeatInterval = setInterval(() => {
      if (!this._roomId || !this.myId) return;
      import('firebase/firestore').then(({ doc, updateDoc, serverTimestamp }) => {
        updateDoc(doc(db, 'game_rooms', this._roomId, 'players', this.myId), {
          lastSeen: serverTimestamp(),
          connected: true,
        }).catch(() => {});
      });
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ─── Helpers ───

  private generateRoomId(): string {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  private generatePlayerId(): string {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}