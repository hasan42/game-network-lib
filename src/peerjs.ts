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

import Peer from 'peerjs';
import type { NetworkManagerInterface, NetworkRole, NetworkEvent } from './types';

export interface PeerJSConfig {
  /** PeerJS server host */
  host: string;
  /** PeerJS server port */
  port: number;
  /** PeerJS server path */
  path: string;
  /** Use secure connection (wss) */
  secure?: boolean;
  /** STUN/TURN servers */
  iceServers?: Array<{ urls: string }>;
}

const DEFAULT_ICE_SERVERS: Array<{ urls: string }> = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

type Listener = (event: NetworkEvent) => void;

export class PeerJSNetworkManager implements NetworkManagerInterface {
  private peer: Peer | null = null;
  private connection: any = null;
  private myId: string = '';
  private _isHost: boolean = false;
  private _role: NetworkRole | null = null;
  private listeners: Listener[] = [];
  private config: PeerJSConfig;

  constructor(config: PeerJSConfig) {
    this.config = config;
  }

  private getPeerOptions(): any {
    return {
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
      secure: this.config.secure ?? false,
      config: {
        iceServers: this.config.iceServers ?? DEFAULT_ICE_SERVERS,
      },
    };
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
        console.error('[PeerJSNetwork] Listener error:', e);
      }
    }
  }

  // ─── Connection ───

  async host(options?: Record<string, unknown>): Promise<string> {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.getPeerOptions());
      this._isHost = true;
      this._role = 'host';

      this.peer.on('open', (id: string) => {
        this.myId = id;
        console.log('[PeerJSNetwork] Host created, room ID:', id);

        this.peer!.on('connection', (conn: any) => {
          console.log('[PeerJSNetwork] Guest connected:', conn.peer);
          this.connection = conn;
          this.setupConnection(conn);
          this.emit({ type: 'connected', payload: { role: 'host' } });
        });

        resolve(id);
      });

      this.peer.on('error', (err: Error) => {
        console.error('[PeerJSNetwork] Host error:', err);
        this.emit({ type: 'error', payload: err });
        reject(err);
      });

      this.peer.on('disconnected', () => {
        this.emit({ type: 'disconnected' });
      });
    });
  }

  async join(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.getPeerOptions());
      this._isHost = false;
      this._role = 'guest';

      this.peer.on('open', (id: string) => {
        this.myId = id;
        console.log('[PeerJSNetwork] Joining room:', roomId);

        const conn = this.peer!.connect(roomId, { reliable: true });
        this.connection = conn;

        conn.on('open', () => {
          console.log('[PeerJSNetwork] Connected to host');
          this.setupConnection(conn);
          this.emit({ type: 'connected', payload: { role: 'guest' } });
          resolve();
        });

        conn.on('error', (err: Error) => {
          console.error('[PeerJSNetwork] Connection error:', err);
          this.emit({ type: 'error', payload: err });
          reject(err);
        });
      });

      this.peer.on('error', (err: Error) => {
        console.error('[PeerJSNetwork] Guest error:', err);
        this.emit({ type: 'error', payload: err });
        reject(err);
      });
    });
  }

  private setupConnection(conn: any) {
    conn.on('data', (data: unknown) => {
      this.emit({ type: 'data', payload: data });
    });

    conn.on('close', () => {
      console.log('[PeerJSNetwork] Connection closed');
      this.connection = null;
      this.emit({ type: 'disconnected' });
    });
  }

  send(data: unknown): boolean {
    if (!this.connection) {
      console.warn('[PeerJSNetwork] No connection, cannot send');
      return false;
    }
    if (this.connection.open === false) {
      console.warn('[PeerJSNetwork] Connection not open, cannot send');
      return false;
    }
    this.connection.send(data);
    return true;
  }

  disconnect(): void {
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

  get role(): NetworkRole | null {
    return this._role;
  }

  get connected(): boolean {
    return this.connection !== null && this.connection.open;
  }

  get roomId(): string {
    return this._isHost ? this.myId : (this.connection?.peer || '');
  }
}