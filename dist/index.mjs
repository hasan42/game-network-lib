// src/types.ts
var GameNetwork = class {
  constructor(config) {
    this.network = null;
    this.config = config;
    this._status = {
      backend: config.backend,
      role: null,
      myPlayerIndex: -1,
      connected: false,
      error: null,
      roomId: null
    };
  }
  get status() {
    return { ...this._status };
  }
  /** Initialize as host */
  async initHost(network) {
    this.network = network;
    const roomId = await network.host();
    network.onData((data) => {
      const msg = data;
      if (msg.type === "action" && msg.action) {
        const playerIndex = msg.playerIndex ?? msg.action.playerIndex ?? -1;
        const innerAction = msg.action.action ?? msg.action;
        this.config.onAction?.({ ...innerAction, playerIndex });
      }
    });
    network.on((event) => {
      if (event.type === "disconnected") {
        this._status.connected = false;
        this.config.onConnectionChange?.(false, this._status.role);
      }
      if (event.type === "error") {
        this._status.error = String(event.payload ?? "Network error");
        this.config.onError?.(this._status.error);
      }
    });
    this._status = {
      ...this._status,
      role: "host",
      myPlayerIndex: 0,
      connected: true,
      error: null,
      roomId
    };
    this.config.onConnectionChange?.(true, "host");
    return roomId;
  }
  /** Initialize as guest */
  async initGuest(network, playerIndex) {
    this.network = network;
    await network.join("");
    const myIndex = playerIndex ?? 1;
    network.onData((data) => {
      const msg = data;
      if (msg.type === "full_state" && msg.state) {
        const idx = msg.myPlayerIndex ?? myIndex;
        this._status.myPlayerIndex = idx;
        this.config.onState?.(msg.state, idx);
      }
    });
    network.on((event) => {
      if (event.type === "disconnected") {
        this._status.connected = false;
        this.config.onConnectionChange?.(false, this._status.role);
      }
      if (event.type === "error") {
        this._status.error = String(event.payload ?? "Network error");
        this.config.onError?.(this._status.error);
      }
    });
    this._status = {
      ...this._status,
      role: "guest",
      myPlayerIndex: myIndex,
      connected: true,
      error: null,
      roomId: "roomId" in network ? network.roomId : null
    };
    this.config.onConnectionChange?.(true, "guest");
  }
  /** Send an action (guest → host) */
  sendAction(action) {
    if (!this.network) return false;
    return this.network.send({ type: "action", action });
  }
  /** Broadcast game state (host → guests) */
  broadcastState(state) {
    if (!this.network) return false;
    return this.network.send({ type: "full_state", state });
  }
  /** Disconnect */
  disconnect() {
    this.network?.disconnect();
    this.network = null;
    this._status = {
      ...this._status,
      role: null,
      myPlayerIndex: -1,
      connected: false,
      error: null,
      roomId: null
    };
    this.config.onConnectionChange?.(false, null);
  }
};
function serializeState(store, excludeKeys = []) {
  const result = {};
  for (const [key, value] of Object.entries(store)) {
    if (typeof value === "function" || excludeKeys.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

// src/peerjs.ts
import Peer from "peerjs";
var DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
var PeerJSNetworkManager = class {
  constructor(config) {
    this.peer = null;
    this.connection = null;
    this.myId = "";
    this._isHost = false;
    this._role = null;
    this.listeners = [];
    this.config = config;
  }
  getPeerOptions() {
    return {
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
      secure: this.config.secure ?? false,
      config: {
        iceServers: this.config.iceServers ?? DEFAULT_ICE_SERVERS
      }
    };
  }
  // ─── EventEmitter ───
  on(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  onData(callback) {
    return this.on((event) => {
      if (event.type === "data") {
        callback(event.payload);
      }
    });
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("[PeerJSNetwork] Listener error:", e);
      }
    }
  }
  // ─── Connection ───
  async host(options) {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.getPeerOptions());
      this._isHost = true;
      this._role = "host";
      this.peer.on("open", (id) => {
        this.myId = id;
        console.log("[PeerJSNetwork] Host created, room ID:", id);
        this.peer.on("connection", (conn) => {
          console.log("[PeerJSNetwork] Guest connected:", conn.peer);
          this.connection = conn;
          this.setupConnection(conn);
          this.emit({ type: "connected", payload: { role: "host" } });
        });
        resolve(id);
      });
      this.peer.on("error", (err) => {
        console.error("[PeerJSNetwork] Host error:", err);
        this.emit({ type: "error", payload: err });
        reject(err);
      });
      this.peer.on("disconnected", () => {
        this.emit({ type: "disconnected" });
      });
    });
  }
  async join(roomId) {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.getPeerOptions());
      this._isHost = false;
      this._role = "guest";
      this.peer.on("open", (id) => {
        this.myId = id;
        console.log("[PeerJSNetwork] Joining room:", roomId);
        const conn = this.peer.connect(roomId, { reliable: true });
        this.connection = conn;
        conn.on("open", () => {
          console.log("[PeerJSNetwork] Connected to host");
          this.setupConnection(conn);
          this.emit({ type: "connected", payload: { role: "guest" } });
          resolve();
        });
        conn.on("error", (err) => {
          console.error("[PeerJSNetwork] Connection error:", err);
          this.emit({ type: "error", payload: err });
          reject(err);
        });
      });
      this.peer.on("error", (err) => {
        console.error("[PeerJSNetwork] Guest error:", err);
        this.emit({ type: "error", payload: err });
        reject(err);
      });
    });
  }
  setupConnection(conn) {
    conn.on("data", (data) => {
      this.emit({ type: "data", payload: data });
    });
    conn.on("close", () => {
      console.log("[PeerJSNetwork] Connection closed");
      this.connection = null;
      this.emit({ type: "disconnected" });
    });
  }
  send(data) {
    if (!this.connection) {
      console.warn("[PeerJSNetwork] No connection, cannot send");
      return false;
    }
    if (this.connection.open === false) {
      console.warn("[PeerJSNetwork] Connection not open, cannot send");
      return false;
    }
    this.connection.send(data);
    return true;
  }
  disconnect() {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    this._role = null;
    this.listeners = [];
  }
  // ─── Getters ───
  get role() {
    return this._role;
  }
  get connected() {
    return this.connection !== null && this.connection.open;
  }
  get roomId() {
    return this._isHost ? this.myId : this.connection?.peer || "";
  }
};

// src/firebase.ts
var FirebaseNetworkManager = class {
  constructor(config) {
    this._roomId = "";
    this.myId = "";
    this._role = null;
    this._playerIndex = -1;
    this._isHost = false;
    this._connected = false;
    this.listeners = [];
    this.unsubscribeRoom = null;
    this.unsubscribePlayers = null;
    this.unsubscribeActions = null;
    this._players = [];
    this.heartbeatInterval = null;
    // Lazy-loaded Firebase instances
    this._app = null;
    this._db = null;
    this.firebaseConfig = config;
  }
  // ─── Firebase Init (lazy) ───
  async getDb() {
    if (!this._db) {
      const { initializeApp } = await import("firebase/app");
      const { getFirestore } = await import("firebase/firestore");
      this._app = initializeApp(this.firebaseConfig);
      this._db = getFirestore(this._app);
    }
    return this._db;
  }
  // ─── EventEmitter ───
  on(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  onData(callback) {
    return this.on((event) => {
      if (event.type === "data") {
        callback(event.payload);
      }
    });
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("[FirebaseNetwork] Listener error:", e);
      }
    }
  }
  // ─── Connection ───
  async host(options) {
    const db = await this.getDb();
    const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
    const maxPlayers = options?.maxPlayers ?? 2;
    const hostName = options?.hostName ?? "Host";
    const roomId = this.generateRoomId();
    const hostId = this.generatePlayerId();
    this._roomId = roomId;
    this.myId = hostId;
    this._isHost = true;
    this._role = "host";
    this._playerIndex = 0;
    const roomRef = doc(db, "game_rooms", roomId);
    await setDoc(roomRef, {
      id: roomId,
      hostId,
      hostName,
      playerCount: 1,
      maxPlayers,
      status: "waiting",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    const playerRef = doc(db, "game_rooms", roomId, "players", hostId);
    await setDoc(playerRef, {
      id: hostId,
      name: "Host",
      roomId,
      index: 0,
      connected: true,
      lastSeen: serverTimestamp()
    });
    this.startHeartbeat(db);
    this.startSubscriptions(db);
    this._connected = true;
    this.emit({ type: "connected", payload: { role: "host", roomId } });
    return roomId;
  }
  async join(roomId, options) {
    const db = await this.getDb();
    const { doc, getDoc, setDoc, updateDoc, serverTimestamp } = await import("firebase/firestore");
    const playerName = options?.playerName ?? "Guest";
    const playerId = this.generatePlayerId();
    const roomRef = doc(db, "game_rooms", roomId);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) {
      throw new Error("Room not found");
    }
    const room = roomSnap.data();
    if (room.status !== "waiting") {
      throw new Error("Room is not accepting players");
    }
    if (room.playerCount >= room.maxPlayers) {
      throw new Error("Room is full");
    }
    const playerIndex = room.playerCount;
    const playerRef = doc(db, "game_rooms", roomId, "players", playerId);
    await setDoc(playerRef, {
      id: playerId,
      name: `${playerName} ${playerIndex + 1}`,
      roomId,
      index: playerIndex,
      connected: true,
      lastSeen: serverTimestamp()
    });
    await updateDoc(roomRef, {
      playerCount: room.playerCount + 1,
      updatedAt: serverTimestamp()
    });
    this._roomId = roomId;
    this.myId = playerId;
    this._isHost = false;
    this._role = "guest";
    this._playerIndex = playerIndex;
    this.startHeartbeat(db);
    this.startSubscriptions(db);
    this._connected = true;
  }
  disconnect() {
    this.stopHeartbeat();
    this.stopSubscriptions();
    if (this._roomId && this.myId) {
      this.leaveRoom().catch(console.error);
    }
    this._roomId = "";
    this.myId = "";
    this._isHost = false;
    this._role = null;
    this._playerIndex = -1;
    this._connected = false;
    this._players = [];
    this.listeners = [];
  }
  send(data) {
    if (!this._connected || !this._roomId) {
      console.warn("[FirebaseNetwork] Not connected, cannot send");
      return false;
    }
    if (this._isHost && data.type === "full_state") {
      this.updateGameState(data.state).catch((e) => {
        console.error("[FirebaseNetwork] Failed to update gameState:", e);
      });
      return true;
    }
    if (!this._isHost) {
      this.sendAction(data).catch(console.error);
      return true;
    }
    return false;
  }
  // ─── Getters ───
  get role() {
    return this._role;
  }
  get connected() {
    return this._connected;
  }
  get roomId() {
    return this._roomId;
  }
  get playerIndex() {
    return this._playerIndex;
  }
  get playerList() {
    return this._players;
  }
  // ─── Private: Firestore operations ───
  async updateGameState(gameState) {
    const db = await this.getDb();
    const { doc, updateDoc, serverTimestamp } = await import("firebase/firestore");
    await updateDoc(doc(db, "game_rooms", this._roomId), {
      gameState,
      updatedAt: serverTimestamp()
    });
  }
  async sendAction(data) {
    const db = await this.getDb();
    const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
    await setDoc(doc(db, "game_rooms", this._roomId, "actions", `${Date.now()}_${this.myId}`), {
      ...data,
      playerId: this.myId,
      playerIndex: this._playerIndex,
      timestamp: serverTimestamp()
    });
  }
  async leaveRoom() {
    const db = await this.getDb();
    const { doc, deleteDoc, getDoc, updateDoc, serverTimestamp } = await import("firebase/firestore");
    await deleteDoc(doc(db, "game_rooms", this._roomId, "players", this.myId));
    const roomRef = doc(db, "game_rooms", this._roomId);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) return;
    const room = roomSnap.data();
    const newCount = Math.max(0, room.playerCount - 1);
    if (newCount === 0) {
      await deleteDoc(roomRef);
    } else {
      await updateDoc(roomRef, {
        playerCount: newCount,
        updatedAt: serverTimestamp()
      });
    }
  }
  // ─── Subscriptions ───
  startSubscriptions(db) {
    import("firebase/firestore").then(({ doc, onSnapshot, collection }) => {
      this.unsubscribeRoom = onSnapshot(doc(db, "game_rooms", this._roomId), (snap) => {
        if (!snap.exists()) {
          this.emit({ type: "disconnected" });
          return;
        }
        const room = snap.data();
        if (!this._isHost && room.gameState) {
          this.emit({ type: "data", payload: { type: "full_state", state: room.gameState, myPlayerIndex: this._playerIndex } });
        }
      });
      this.unsubscribePlayers = onSnapshot(collection(db, "game_rooms", this._roomId, "players"), (snap) => {
        this._players = [];
        snap.forEach((d) => {
          this._players.push(d.data());
        });
      });
      if (this._isHost) {
        this.startActionListener(db);
      }
    });
  }
  startActionListener(db) {
    import("firebase/firestore").then(({ collection, onSnapshot, deleteDoc, doc, query, orderBy }) => {
      const actionsRef = collection(db, "game_rooms", this._roomId, "actions");
      const q = query(actionsRef, orderBy("timestamp"));
      this.unsubscribeActions = onSnapshot(q, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            const action = change.doc.data();
            this.emit({ type: "data", payload: { type: "action", action } });
            deleteDoc(doc(db, "game_rooms", this._roomId, "actions", change.doc.id)).catch(() => {
            });
          }
        });
      });
    });
  }
  stopSubscriptions() {
    this.unsubscribeRoom?.();
    this.unsubscribeRoom = null;
    this.unsubscribePlayers?.();
    this.unsubscribePlayers = null;
    this.unsubscribeActions?.();
    this.unsubscribeActions = null;
  }
  // ─── Heartbeat ───
  startHeartbeat(db) {
    this.heartbeatInterval = setInterval(() => {
      if (!this._roomId || !this.myId) return;
      import("firebase/firestore").then(({ doc, updateDoc, serverTimestamp }) => {
        updateDoc(doc(db, "game_rooms", this._roomId, "players", this.myId), {
          lastSeen: serverTimestamp(),
          connected: true
        }).catch(() => {
        });
      });
    }, 1e4);
  }
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  // ─── Helpers ───
  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }
  generatePlayerId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
};
export {
  FirebaseNetworkManager,
  GameNetwork,
  PeerJSNetworkManager,
  serializeState
};
