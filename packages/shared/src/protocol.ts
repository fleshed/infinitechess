import type { Coord, PieceId, PieceType, PlayerId, WorldSnapshot } from './types.js';

// --- Client -> Server ---

export interface C2S_Hello {
  name?: string;
}

export interface C2S_MoveIntent {
  pieceId: PieceId;
  target: Coord;
}

export interface C2S_FormationMove {
  pieceIds: PieceId[];
  target: Coord;
}

export interface C2S_CancelGoal {
  pieceId: PieceId;
}

export interface C2S_LeaveFormation {
  pieceId: PieceId;
}

export interface C2S_SellPiece {
  pieceId: PieceId;
}

export interface C2S_BuyPiece {
  type: PieceType;
  pos: Coord;
}

export interface C2S_UpgradePiece {
  pieceIds: PieceId[];
}

export interface C2S_PlaceBomb {
  pos: Coord;
}

export interface C2S_Viewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ClientToServerEvents {
  hello: (msg: C2S_Hello) => void;
  moveIntent: (msg: C2S_MoveIntent) => void;
  formationMove: (msg: C2S_FormationMove) => void;
  cancelGoal: (msg: C2S_CancelGoal) => void;
  leaveFormation: (msg: C2S_LeaveFormation) => void;
  sellPiece: (msg: C2S_SellPiece) => void;
  buyPiece: (msg: C2S_BuyPiece) => void;
  upgradePiece: (msg: C2S_UpgradePiece) => void;
  placeBomb: (msg: C2S_PlaceBomb) => void;
  viewport: (msg: C2S_Viewport) => void;
}

// --- Server -> Client ---

export interface S2C_Welcome {
  playerId: PlayerId;
  tickMs: number;
  serverTick: number;
  snapshot: WorldSnapshot;
}

export interface S2C_Error {
  code: string;
  message: string;
}

export interface ServerToClientEvents {
  welcome: (msg: S2C_Welcome) => void;
  snapshot: (msg: WorldSnapshot) => void;
  error: (msg: S2C_Error) => void;
}
