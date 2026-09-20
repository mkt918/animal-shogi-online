/**
 * CPU対戦の思考ルーチン(Firebase非依存の純粋ロジック)。
 * ミニマックス+アルファベータ枝刈り。強さは探索の深さで変える。
 *
 *   'easy'   … 完全ランダム(たまにしか勝ち筋を読まない、初心者向け)
 *   'normal' … 2手先まで読む
 *   'hard'   … 4手先まで読む
 */

const DEPTH_BY_DIFFICULTY = { easy: 0, normal: 2, hard: 4 };

// 駒の価値。ライオンは「捕られたら即負け」なので別枠で終局判定するが、
// 評価関数の中でも危険度を伝えるためかなり大きい値にしておく。
const PIECE_VALUE = {
  chick: 100,
  elephant: 300,
  giraffe: 350,
  hen: 450,
  lion: 10000,
};

const WIN_SCORE = 1000000;

function otherOwner(owner) {
  return owner === 'sente' ? 'gote' : 'sente';
}

/** 現在の手番が指せる手を全列挙する。盤上の移動+持ち駒を打つ手。 */
function generateMoves(GameLogic, state) {
  const owner = state.turn;
  const moves = [];

  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      const piece = state.board[r][c];
      if (!piece || piece.owner !== owner) continue;
      const dests = GameLogic.getPieceDestinations(state, r, c);
      for (const d of dests) {
        moves.push({ kind: 'move', from: { row: r, col: c }, to: d });
      }
    }
  }

  const droppedTypes = new Set();
  for (const pieceType of state.hands[owner]) {
    if (droppedTypes.has(pieceType)) continue; // 同種の持ち駒は打てる場所が同じなので重複を省く
    droppedTypes.add(pieceType);
    for (const d of GameLogic.getDropDestinations(state)) {
      moves.push({ kind: 'drop', pieceType, to: d });
    }
  }

  return moves;
}

function applyMove(GameLogic, state, move) {
  if (move.kind === 'move') return GameLogic.movePiece(state, move.from, move.to);
  return GameLogic.dropPiece(state, move.pieceType, move.to);
}

/**
 * 盤面を perspective(手番に関係なく固定した視点)から評価する。
 * 駒の価値の合計(盤上+持ち駒)に、ヒヨコの前進度など簡単な位置評価を足す。
 */
function evaluate(GameLogic, state, perspective) {
  if (state.winner) {
    if (state.winner === 'draw') return 0;
    return state.winner === perspective ? WIN_SCORE : -WIN_SCORE;
  }

  let score = 0;
  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      const p = state.board[r][c];
      if (!p) continue;
      const sign = p.owner === perspective ? 1 : -1;
      let value = PIECE_VALUE[p.type];
      if (p.type === 'chick') {
        // 相手陣に近いヒヨコほど成りが近く価値が高い(先手は row 0 が最奥、後手は row 3 が最奥)
        const advancement = p.owner === 'sente' ? (GameLogic.BOARD_ROWS - 1 - r) : r;
        value += advancement * 15;
      }
      score += sign * value;
    }
  }

  for (const owner of ['sente', 'gote']) {
    const sign = owner === perspective ? 1 : -1;
    for (const pieceType of state.hands[owner]) {
      // 持ち駒は「どこにでも打てる」柔軟性があるぶん、盤上の同種駒よりわずかに割り引く
      score += sign * PIECE_VALUE[pieceType] * 0.9;
    }
  }

  return score;
}

function minimax(GameLogic, state, depth, alpha, beta, perspective) {
  if (state.winner || depth === 0) {
    return evaluate(GameLogic, state, perspective);
  }

  const moves = generateMoves(GameLogic, state);
  if (moves.length === 0) {
    // 指せる手がない(通常のどうぶつしょうぎではほぼ起こらないが念のため)
    return evaluate(GameLogic, state, perspective);
  }

  const maximizing = state.turn === perspective;
  let best = maximizing ? -Infinity : Infinity;

  for (const move of moves) {
    const next = applyMove(GameLogic, state, move);
    const val = minimax(GameLogic, next, depth - 1, alpha, beta, perspective);
    if (maximizing) {
      if (val > best) best = val;
      if (best > alpha) alpha = best;
    } else {
      if (val < best) best = val;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break; // 枝刈り
  }
  return best;
}

/**
 * CPUの一手を選ぶ。state.turn 側がCPUという前提。
 * difficulty: 'easy' | 'normal' | 'hard'
 */
function chooseMove(GameLogic, state, difficulty) {
  const moves = generateMoves(GameLogic, state);
  if (moves.length === 0) return null;

  if (difficulty === 'easy') {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const perspective = state.turn;
  const depth = DEPTH_BY_DIFFICULTY[difficulty] ?? DEPTH_BY_DIFFICULTY.normal;

  let bestScore = -Infinity;
  let scored = [];
  for (const move of moves) {
    const next = applyMove(GameLogic, state, move);
    const score = minimax(GameLogic, next, depth - 1, -Infinity, Infinity, perspective);
    scored.push({ move, score });
    if (score > bestScore) bestScore = score;
  }

  // 最善手とほぼ同点の候補からランダムに選び、毎回同じ棋譜にならないようにする
  const margin = Math.abs(bestScore) < WIN_SCORE ? 20 : 0;
  const topChoices = scored.filter((s) => s.score >= bestScore - margin);
  return topChoices[Math.floor(Math.random() * topChoices.length)].move;
}

const CpuAI = { chooseMove, generateMoves, evaluate };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CpuAI;
} else {
  window.CpuAI = CpuAI;
}
