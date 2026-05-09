# game-network-lib

Real-time multiplayer networking library for games.

**Architecture:** Host-authoritative pattern — host owns game state, guests send actions.

**Backends:**
- **PeerJS** — P2P via WebRTC, best for 2-player games
- **Firebase** — Firestore real-time sync, best for 2-6 players

## Install

```bash
npm install hasan42/game-network-lib
```

## Usage

### PeerJS (2 players, P2P)

```typescript
import { GameNetwork, PeerJSNetworkManager } from 'game-network-lib';
import { useGameStore } from './engine/store';

const network = new PeerJSNetworkManager({
  host: 'localhost',
  port: 9000,
  path: '/myapp',
});

const gameNet = new GameNetwork({
  backend: 'peerjs',
  onAction: (action) => {
    // Host: apply guest's action to your game state
    applyAction(action);
  },
  onState: (state, myPlayerIndex) => {
    // Guest: update local state from host
    useGameStore.setState(state);
  },
});

// Host
const roomId = await gameNet.initHost(network);
console.log('Room ID:', roomId);

// Guest
await gameNet.initGuest(network, 1);
console.log('Connected as player', gameNet.status.myPlayerIndex);
```

### Firebase (2-6 players, real-time)

```typescript
import { GameNetwork, FirebaseNetworkManager } from 'game-network-lib';

const network = new FirebaseNetworkManager({
  apiKey: '...',
  authDomain: '...',
  projectId: '...',
  // ... other Firebase config
});

const gameNet = new GameNetwork({
  backend: 'firebase',
  onAction: (action) => applyAction(action),
  onState: (state) => updateLocalState(state),
});

// Host
const roomId = await gameNet.initHost(network);

// Guest
await gameNet.initGuest(network);
```

### Host broadcasts state

```typescript
// Host: after each game state change, broadcast to guests
gameNet.broadcastState(useGameStore.getState());
```

### Guest sends action

```typescript
// Guest: send action to host
gameNet.sendAction({ type: 'attack', cardId: 'hearts-14' });
```

## API

### `GameNetwork<S, A>`

Generic game network client. `S` = your game state type, `A` = your action type.

- `initHost(network)` — start as host, returns room ID
- `initGuest(network, playerIndex?)` — join as guest
- `sendAction(action)` — guest → host action
- `broadcastState(state)` — host → guests state update
- `disconnect()` — clean up
- `status` — current connection status

### `PeerJSNetworkManager`

Implements `NetworkManagerInterface`. Config: `{ host, port, path, secure?, iceServers? }`

### `FirebaseNetworkManager`

Implements `NetworkManagerInterface`. Config: Firebase config object.

## License

MIT