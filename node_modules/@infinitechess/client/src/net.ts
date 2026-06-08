import { io, Socket } from 'socket.io-client';
import type {
  C2S_Viewport,
  ClientToServerEvents,
  Coord,
  PieceType,
  ServerToClientEvents,
} from '@infinitechess/shared';
import { GameState } from './state.js';

export class Net {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;

  constructor(
    private state: GameState,
    private onStatus: (msg: string) => void,
    private onWelcome: () => void,
  ) {
    this.socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

    this.socket.on('connect', () => {
      this.onStatus('connected — joining world...');
      this.socket.emit('hello', { name: '' });
    });

    this.socket.on('disconnect', () => this.onStatus('disconnected'));

    this.socket.on('welcome', (msg) => {
      this.state.playerId = msg.playerId;
      this.state.tickMs = msg.tickMs;
      this.state.setSnapshot(msg.snapshot);
      this.onStatus(`you are player ${msg.playerId.slice(0, 6)}`);
      this.onWelcome();
    });

    this.socket.on('snapshot', (snap) => this.state.setSnapshot(snap));

    this.socket.on('error', (err) => {
      console.warn('[server error]', err);
    });
  }

  sendMoveIntent(pieceId: string, target: Coord): void {
    this.socket.emit('moveIntent', { pieceId, target });
  }

  sendFormationMove(pieceIds: string[], target: Coord): void {
    this.socket.emit('formationMove', { pieceIds, target });
  }

  sendCancelGoal(pieceId: string): void {
    this.socket.emit('cancelGoal', { pieceId });
  }

  sendLeaveFormation(pieceId: string): void {
    this.socket.emit('leaveFormation', { pieceId });
  }

  sendSellPiece(pieceId: string): void {
    this.socket.emit('sellPiece', { pieceId });
  }

  sendPlaceBomb(pos: Coord): void {
    this.socket.emit('placeBomb', { pos });
  }

  sendBuyPiece(type: PieceType, pos: Coord): void {
    this.socket.emit('buyPiece', { type, pos });
  }

  sendUpgrade(pieceIds: string[]): void {
    if (pieceIds.length === 0) return;
    this.socket.emit('upgradePiece', { pieceIds });
  }

  sendViewport(vp: C2S_Viewport): void {
    if (!this.socket.connected) return;
    this.socket.emit('viewport', vp);
  }
}
