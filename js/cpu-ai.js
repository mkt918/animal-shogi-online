/**
 * CPU対戦の思考ルーチン(Firebase非依存の純粋ロジック)。
 * ミニマックス+アルファベータ枝刈りに、検証済みの定跡(オープニングブック)を組み合わせる。
 * 強さは★1〜★10の7段階(docs/strategy-guide.md の難易度マッピングに対応)。
 *
 * 定跡データは docs/strategy-guide.md 第3.4節に基づく「ゾウ冠」基本形の最初の5手
 * (▲B2ひよこ →△同ゾウ →▲B3ゾウ →△A2きりん →▲A2同ゾウ)。
 * 実際のゲームエンジンで全手が合法であることを検証済み(README参照)。
 */

/**
 * 強さティア。stars は表示用(1〜10の★)。depth はミニマックスの探索深さ、
 * book は「盤面の履歴が定跡と完全一致している間、先頭何手まで定跡を優先するか」。
 * marginScale は「最善手とほぼ同点の候補からランダムに選ぶ」際の許容幅の倍率
 * (0にすると常に単独の最善手を選ぶ = 最強ティアはブレない)。
 */
const TIERS = [
  { id: 'easy', label: 'かんたん', stars: 1, depth: 0, book: 0, marginScale: 1 },
  { id: 'normal', label: 'ふつう', stars: 3, depth: 2, book: 0, marginScale: 1 },
  { id: 'hard', label: 'つよい', stars: 5, depth: 4, book: 0, marginScale: 1 },
  { id: 'joseki-weak', label: '弱定石', stars: 6, depth: 4, book: 2, marginScale: 1 },
  { id: 'joseki-mid', label: '中定石', stars: 7, depth: 6, book: 4, marginScale: 0.75 },
  { id: 'joseki-strong', label: '強定石', stars: 8, depth: 6, book: 5, marginScale: 0.5 },
  { id: 'master', label: '最強', stars: 10, depth: 8, book: 5, marginScale: 0 },
];
const MAX_STARS = 10;
const STAR_MARGIN_UNIT = 20; // marginScale=1 のときの許容幅(評価値ポイント)

const TIER_BY_ID = new Map(TIERS.map((t) => [t.id, t]));

function getTier(tierId) {
  return TIER_BY_ID.get(tierId) || TIER_BY_ID.get('hard');
}

/** ★の表示文字列を作る(例: stars=6 → "★★★★★★☆☆☆☆") */
function starDisplay(stars) {
  return '★'.repeat(stars) + '☆'.repeat(MAX_STARS - stars);
}

/**
 * 検証済みオープニングブック(ゾウ冠基本形、先頭5手)。
 * 座標は本プロジェクトの内部表現(row0=後手最奥 / row3=先手最奥、col: A=0,B=1,C=2)。
 */
const OPENING_BOOK = [
  { label: '▲B2ひよこ', explanation: 'ヒヨコで相手のヒヨコを取りに行く、素直で穏やかな初手。「ゾウ冠」定跡へ進む。', move: { kind: 'move', from: { row: 2, col: 1 }, to: { row: 1, col: 1 } } },
  { label: '△同ゾウ', explanation: 'ヒヨコを同じ場所のゾウで取り返す。完全解析上、後手のこの応手が最善とされる。', move: { kind: 'move', from: { row: 0, col: 2 }, to: { row: 1, col: 1 } } },
  { label: '▲B3ゾウ', explanation: '自分のゾウを前進させ、ライオンの守りを固める「ゾウ冠」の形を作る。', move: { kind: 'move', from: { row: 3, col: 0 }, to: { row: 2, col: 1 } } },
  { label: '△A2きりん', explanation: 'キリンを繰り出して盤面をコントロールする。', move: { kind: 'move', from: { row: 0, col: 0 }, to: { row: 1, col: 0 } } },
  { label: '▲A2同ゾウ', explanation: 'ゾウでキリンを取り返す。ここまでが検証済みの定跡区間。', move: { kind: 'move', from: { row: 2, col: 1 }, to: { row: 1, col: 0 } } },
];

function movesEqual(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'move') {
    return a.from.row === b.from.row && a.from.col === b.from.col && a.to.row === b.to.row && a.to.col === b.to.col;
  }
  return a.pieceType === b.pieceType && a.to.row === b.to.row && a.to.col === b.to.col;
}

/**
 * これまでの指し手履歴(moveHistory)が定跡の先頭と完全一致している場合、次の定跡手を返す。
 * 一致しなくなった時点(相手が定跡を外れた/自分がすでに定跡区間を終えた)は null。
 */
function bookMoveForHistory(moveHistory) {
  const ply = moveHistory.length;
  if (ply >= OPENING_BOOK.length) return null;
  for (let i = 0; i < ply; i++) {
    if (!movesEqual(moveHistory[i], OPENING_BOOK[i].move)) return null;
  }
  return OPENING_BOOK[ply];
}

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
 * tierId: TIERS の id('easy' | 'normal' | 'hard' | 'joseki-weak' | 'joseki-mid' | 'joseki-strong' | 'master')
 * moveHistory: これまでの対局で実際に指された手の配列(定跡判定に使う。省略時は定跡なしとして扱う)。
 */
function chooseMove(GameLogic, state, tierId, moveHistory) {
  const moves = generateMoves(GameLogic, state);
  if (moves.length === 0) return null;

  const tier = getTier(tierId);

  if (tier.book > 0 && moveHistory) {
    const book = bookMoveForHistory(moveHistory);
    if (book) return book.move;
  }

  if (tier.depth === 0) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const perspective = state.turn;
  let bestScore = -Infinity;
  let scored = [];
  for (const move of moves) {
    const next = applyMove(GameLogic, state, move);
    const score = minimax(GameLogic, next, tier.depth - 1, -Infinity, Infinity, perspective);
    scored.push({ move, score });
    if (score > bestScore) bestScore = score;
  }

  // 最善手とほぼ同点の候補からランダムに選び、毎回同じ棋譜にならないようにする
  // (marginScale=0 のティアは常に単独の最善手を選ぶ)
  const margin = Math.abs(bestScore) < WIN_SCORE ? STAR_MARGIN_UNIT * tier.marginScale : 0;
  const topChoices = scored.filter((s) => s.score >= bestScore - margin);
  return topChoices[Math.floor(Math.random() * topChoices.length)].move;
}

const CpuAI = {
  chooseMove,
  generateMoves,
  evaluate,
  TIERS,
  starDisplay,
  bookMoveForHistory,
  OPENING_BOOK,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CpuAI;
} else {
  window.CpuAI = CpuAI;
}
