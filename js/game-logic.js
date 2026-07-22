/**
 * どうぶつしょうぎ ルールエンジン(Firebase非依存の純粋ロジック)
 *
 * 盤面: 3列 x 4段。座標は {row, col}, row 0 が後手(Gote)側最奥、row 3 が先手(Sente)側最奥。
 * 駒種: lion, elephant, giraffe, chick, hen(ヒヨコの成り)
 * 手番: 'sente' | 'gote'
 */

const BOARD_ROWS = 4;
const BOARD_COLS = 3;

const PIECE_NAMES = {
  lion: 'ライオン',
  elephant: 'ゾウ',
  giraffe: 'キリン',
  chick: 'ヒヨコ',
  hen: 'ニワトリ',
};

// 各駒の移動可能方向。dr, dc は「先手(下向き=盤面row増加方向が前)」から見た相対座標。
// 後手の場合は移動生成時に上下反転して使う。
const MOVES = {
  lion: [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ],
  elephant: [
    [-1, -1], [-1, 1],
    [1, -1], [1, 1],
  ],
  giraffe: [
    [-1, 0], [0, -1], [0, 1], [1, 0],
  ],
  chick: [
    [-1, 0],
  ],
  hen: [
    // 金将と同じ動き
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, 0],
  ],
};

function createInitialState() {
  const board = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));

  // 後手(gote) 最奥列 row 0
  board[0][0] = { type: 'giraffe', owner: 'gote' };
  board[0][1] = { type: 'lion', owner: 'gote' };
  board[0][2] = { type: 'elephant', owner: 'gote' };
  board[1][1] = { type: 'chick', owner: 'gote' };

  // 先手(sente) 最奥列 row 3
  board[3][0] = { type: 'elephant', owner: 'sente' };
  board[3][1] = { type: 'lion', owner: 'sente' };
  board[3][2] = { type: 'giraffe', owner: 'sente' };
  board[2][1] = { type: 'chick', owner: 'sente' };

  return {
    board,
    turn: 'sente',
    hands: { sente: [], gote: [] }, // 持ち駒: ['chick', 'giraffe', ...]
    winner: null, // null | 'sente' | 'gote'
    winReason: null, // 'capture' | 'try'
    moveCount: 0,
  };
}

function inBounds(row, col) {
  return row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS;
}

function cloneState(state) {
  return {
    board: state.board.map((row) => row.map((cell) => (cell ? { ...cell } : null))),
    turn: state.turn,
    hands: { sente: [...state.hands.sente], gote: [...state.hands.gote] },
    winner: state.winner,
    winReason: state.winReason,
    moveCount: state.moveCount,
  };
}

/** 盤上のある駒が到達できるマス一覧(自駒があるマスは除く)を返す */
function getPieceDestinations(state, row, col) {
  const piece = state.board[row][col];
  if (!piece) return [];
  const dirs = MOVES[piece.type];
  const forwardSign = piece.owner === 'sente' ? 1 : -1; // sente視点dr(-1=前)を実座標に変換
  const dests = [];
  for (const [dr, dc] of dirs) {
    const nr = row + dr * forwardSign;
    const nc = col + dc; // 左右はownerに関係なく反転不要(盤は左右対称)
    if (!inBounds(nr, nc)) continue;
    const target = state.board[nr][nc];
    if (target && target.owner === piece.owner) continue;
    dests.push({ row: nr, col: nc });
  }
  return dests;
}

/** 持ち駒を打てるマス一覧(空マス全部) */
function getDropDestinations(state) {
  const dests = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = 0; c < BOARD_COLS; c++) {
      if (!state.board[r][c]) dests.push({ row: r, col: c });
    }
  }
  return dests;
}

function isLastRowFor(owner, row) {
  return owner === 'sente' ? row === 0 : row === BOARD_ROWS - 1;
}

/**
 * 盤上の駒を動かす。プロモーション判定込み。state は変更せず新しい state を返す。
 */
function movePiece(state, from, to) {
  const next = cloneState(state);
  const piece = next.board[from.row][from.col];
  if (!piece) throw new Error('移動元に駒がありません');

  const captured = next.board[to.row][to.col];
  if (captured) {
    const capturedType = captured.type === 'hen' ? 'chick' : captured.type;
    next.hands[piece.owner].push(capturedType);
    if (captured.type === 'lion') {
      next.winner = piece.owner;
      next.winReason = 'capture';
    }
  }

  next.board[from.row][from.col] = null;

  // ヒヨコが最奥列に到達したらニワトリに成る
  if (piece.type === 'chick' && isLastRowFor(piece.owner, to.row)) {
    piece.type = 'hen';
  }

  next.board[to.row][to.col] = piece;

  // トライルール(簡易版): ライオンが相手最奥列に到達したら即勝利
  if (piece.type === 'lion' && !next.winner) {
    const enemyLastRow = piece.owner === 'sente' ? 0 : BOARD_ROWS - 1;
    if (to.row === enemyLastRow) {
      next.winner = piece.owner;
      next.winReason = 'try';
    }
  }

  next.moveCount += 1;
  next.turn = piece.owner === 'sente' ? 'gote' : 'sente';
  return next;
}

/**
 * 持ち駒を打つ。
 */
function dropPiece(state, pieceType, to) {
  const next = cloneState(state);
  const owner = next.turn;
  const handIndex = next.hands[owner].indexOf(pieceType);
  if (handIndex === -1) throw new Error('持ち駒にありません');
  if (next.board[to.row][to.col]) throw new Error('駒がある場所には打てません');

  next.hands[owner].splice(handIndex, 1);
  next.board[to.row][to.col] = { type: pieceType, owner };
  next.moveCount += 1;
  next.turn = owner === 'sente' ? 'gote' : 'sente';
  return next;
}

function isGameOver(state) {
  return !!state.winner;
}

const GameLogic = {
  BOARD_ROWS,
  BOARD_COLS,
  PIECE_NAMES,
  createInitialState,
  cloneState,
  getPieceDestinations,
  getDropDestinations,
  movePiece,
  dropPiece,
  isGameOver,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GameLogic;
} else {
  window.GameLogic = GameLogic;
}
