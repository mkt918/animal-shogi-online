// CPU練習モード: Firebase不要のローカル対局。プレイヤーは常に先手、CPUは常に後手。
// 強さは js/cpu-ai.js の TIERS(★1〜★10、7段階)をそのまま使う — 表示とCPUの強さが同じデータ元。

const PIECE_EMOJI = {
  lion: '🦁',
  elephant: '🐘',
  giraffe: '🦒',
  chick: '🐤',
  hen: '🐔',
};

const TIER_DESCRIPTION = {
  easy: 'ランダムに指すCPU。ルールに慣れたい人向け。',
  normal: '2手先まで読みます。',
  hard: '4手先まで読む本気モード。',
  'joseki-weak': '序盤2手だけ定跡を使います。それ以降は4手読み。',
  'joseki-mid': '序盤4手を定跡通りに。それ以降は6手読み。',
  'joseki-strong': '定跡区間をフルに活用し、6手読みでブレもさらに少なめ。',
  master: '定跡+8手読み。最善手をほぼ外しません。',
};

const TIER_BTN_CLASS = {
  easy: 'btn--pear', normal: 'btn--pear', hard: 'btn--pear',
  'joseki-weak': 'btn--cyan', 'joseki-mid': 'btn--cyan', 'joseki-strong': 'btn--cyan',
  master: 'btn--coral',
};

const CPU_THINK_MIN_MS = 450; // 一瞬で指すと不自然なので最低これだけ「考える」演出を入れる

let state = null;
let difficulty = null;
let selected = null; // { kind: 'board', row, col } | { kind: 'hand', index }
let cpuThinking = false;
let moveHistory = []; // これまでの対局で実際に指された手(定跡ブックの判定・学習ヒントに使う)
let learningMode = false;

const el = (id) => document.getElementById(id);

function buildDifficultyGrid() {
  const grid = el('difficulty-grid');
  grid.innerHTML = '';
  CpuAI.TIERS.forEach((tier) => {
    const card = document.createElement('div');
    card.className = 'lobby-card difficulty-card';

    const label = document.createElement('span');
    label.className = 'mono-label';
    label.textContent = CpuAI.starDisplay(tier.stars);
    card.appendChild(label);

    const h2 = document.createElement('h2');
    h2.textContent = tier.label;
    card.appendChild(h2);

    const p = document.createElement('p');
    p.className = 'lobby-card-copy';
    p.textContent = TIER_DESCRIPTION[tier.id] || '';
    card.appendChild(p);

    const btn = document.createElement('button');
    btn.className = `btn ${TIER_BTN_CLASS[tier.id] || 'btn--outline'} difficulty-btn`;
    btn.textContent = `${tier.label}で練習`;
    btn.addEventListener('click', () => startGame(tier.id));
    card.appendChild(btn);

    grid.appendChild(card);
  });
}

function tierLabel(tierId) {
  const tier = CpuAI.TIERS.find((t) => t.id === tierId);
  return tier ? `${tier.label} ${CpuAI.starDisplay(tier.stars)}` : tierId;
}

function startGame(diff) {
  difficulty = diff;
  state = GameLogic.createInitialState();
  selected = null;
  cpuThinking = false;
  moveHistory = [];
  learningMode = el('learning-mode-toggle').checked;
  el('difficulty-display').textContent = tierLabel(diff);
  el('select-screen').classList.add('hidden');
  el('game-screen').classList.remove('hidden');
  render();
}

function render() {
  if (!state) return;

  if (state.winner) {
    const resultEl = el('result-msg');
    const wasHidden = resultEl.classList.contains('hidden');
    let text;
    if (state.winner === 'draw') {
      text = '引き分け(千日手)';
    } else {
      const reasonLabel = { try: 'トライ', capture: 'ライオンをキャッチ' }[state.winReason] || '';
      text = state.winner === 'sente' ? `あなたの勝ち!(${reasonLabel})` : `CPUの勝ち(${reasonLabel})`;
    }
    resultEl.textContent = text;
    resultEl.classList.toggle('result-msg--draw', state.winner === 'draw');
    resultEl.classList.toggle('result-msg--lose', state.winner === 'gote');
    resultEl.classList.remove('hidden');
    if (wasHidden && state.winner === 'sente') {
      const burst = document.createElement('span');
      burst.className = 'star-burst';
      resultEl.appendChild(burst);
      burst.addEventListener('animationend', () => burst.remove());
    }
    el('turn-indicator').textContent = '対局終了';
    el('turn-indicator').classList.remove('status-msg--mine');
    el('retry-btn').classList.remove('hidden');
  } else {
    el('result-msg').classList.add('hidden');
    el('retry-btn').classList.add('hidden');
    const turnEl = el('turn-indicator');
    if (cpuThinking) {
      turnEl.textContent = 'CPUが考え中…';
      turnEl.classList.remove('status-msg--mine');
    } else if (state.turn === 'sente') {
      turnEl.textContent = 'あなたの番です。駒をタップして動かしましょう';
      turnEl.classList.add('status-msg--mine');
    } else {
      turnEl.textContent = 'CPUの番です';
      turnEl.classList.remove('status-msg--mine');
    }
  }

  renderHint();
  renderBoard();
  renderHand('sente');
  renderHand('gote');
}

/** 学習モード中、盤面の履歴が定跡と一致していて自分の手番なら、おすすめの一手を案内する */
function renderHint() {
  const hintEl = el('joseki-hint');
  if (!learningMode || state.winner || state.turn !== 'sente' || cpuThinking) {
    hintEl.classList.add('hidden');
    return;
  }
  const book = CpuAI.bookMoveForHistory(moveHistory);
  if (!book) {
    hintEl.classList.add('hidden');
    return;
  }
  hintEl.innerHTML = `<strong>定跡のヒント: ${book.label}</strong><br>${book.explanation}`;
  hintEl.classList.remove('hidden');
}

function renderBoard() {
  const boardEl = el('board');
  boardEl.innerHTML = '';

  const legalDests = getLegalDestinationsForSelection();
  const myTurnActive = !state.winner && state.turn === 'sente' && !cpuThinking;
  const last = state.lastMove;
  const hint = (learningMode && myTurnActive) ? CpuAI.bookMoveForHistory(moveHistory) : null;

  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      const piece = state.board[r][c];
      const isOwnMovable = myTurnActive && piece && piece.owner === 'sente';
      if (piece) {
        const rotated = piece.owner !== 'sente'; // プレイヤー視点固定なので、後手(CPU)の駒だけ回転
        cell.appendChild(createPieceElement(piece, rotated));
        if (isOwnMovable) {
          cell.classList.add('selectable');
          cell.addEventListener('mouseenter', () => previewDestinations(GameLogic.getPieceDestinations(state, r, c)));
          cell.addEventListener('mouseleave', clearPreview);
        }
      }

      if (selected && selected.kind === 'board' && selected.row === r && selected.col === c) {
        cell.classList.add('selected');
      }
      if (legalDests.some((d) => d.row === r && d.col === c)) {
        cell.classList.add('destination', 'selectable');
      }
      if (last && ((last.from && last.from.row === r && last.from.col === c) || (last.to.row === r && last.to.col === c))) {
        cell.classList.add('last-move');
      }
      if (hint && hint.move.kind === 'move' && hint.move.from.row === r && hint.move.from.col === c) {
        cell.classList.add('hint-from');
      }
      if (hint && hint.move.to.row === r && hint.move.to.col === c) {
        cell.classList.add('hint-to');
      }

      cell.addEventListener('click', () => onCellClick(r, c));
      boardEl.appendChild(cell);
    }
  }
}

function createPieceElement(piece, rotated) {
  const pieceEl = document.createElement('div');
  pieceEl.className = `piece owner-${piece.owner}${rotated ? ' piece-rotated' : ''}`;
  pieceEl.innerHTML = `<span class="emoji">${PIECE_EMOJI[piece.type]}</span><span class="piece-name">${GameLogic.PIECE_NAMES[piece.type]}</span>`;
  for (const [dr, dc] of GameLogic.MOVES[piece.type]) {
    const dot = document.createElement('i');
    dot.className = `move-dot dr${dr} dc${dc}`;
    pieceEl.appendChild(dot);
  }
  return pieceEl;
}

function previewDestinations(dests) {
  if (selected) return;
  clearPreview();
  dests.forEach((d) => {
    const cellEl = document.querySelector(`.cell[data-row="${d.row}"][data-col="${d.col}"]`);
    if (cellEl) cellEl.classList.add('reachable-preview');
  });
}

function clearPreview() {
  document.querySelectorAll('.cell.reachable-preview').forEach((c) => c.classList.remove('reachable-preview'));
}

function renderHand(owner) {
  const container = el(`hand-${owner}-pieces`);
  container.innerHTML = '';
  const canInteract = owner === 'sente' && state.turn === 'sente' && !state.winner && !cpuThinking;

  state.hands[owner].forEach((pieceType, idx) => {
    const pieceEl = document.createElement('div');
    pieceEl.className = 'hand-piece' + (canInteract ? '' : ' disabled');
    pieceEl.textContent = PIECE_EMOJI[pieceType];
    pieceEl.title = GameLogic.PIECE_NAMES[pieceType];
    if (selected && selected.kind === 'hand' && selected.index === idx) {
      pieceEl.classList.add('selected');
    }
    if (canInteract) {
      pieceEl.addEventListener('click', () => onHandPieceClick(idx, pieceType));
      pieceEl.addEventListener('mouseenter', () => previewDestinations(GameLogic.getDropDestinations(state)));
      pieceEl.addEventListener('mouseleave', clearPreview);
    }
    container.appendChild(pieceEl);
  });

  const emptyEl = document.createElement('span');
  emptyEl.className = 'hand-empty';
  emptyEl.textContent = 'なし';
  if (state.hands[owner].length === 0) container.appendChild(emptyEl);
}

function getLegalDestinationsForSelection() {
  if (!selected) return [];
  if (selected.kind === 'board') {
    return GameLogic.getPieceDestinations(state, selected.row, selected.col);
  }
  return GameLogic.getDropDestinations(state);
}

function onCellClick(row, col) {
  if (!state || state.winner || state.turn !== 'sente' || cpuThinking) return;

  const piece = state.board[row][col];

  if (selected) {
    const dests = getLegalDestinationsForSelection();
    const isLegal = dests.some((d) => d.row === row && d.col === col);
    if (isLegal) {
      if (selected.kind === 'board') {
        const from = { row: selected.row, col: selected.col };
        moveHistory.push({ kind: 'move', from, to: { row, col } });
        state = GameLogic.movePiece(state, from, { row, col });
      } else {
        const pieceType = state.hands.sente[selected.index];
        moveHistory.push({ kind: 'drop', pieceType, to: { row, col } });
        state = GameLogic.dropPiece(state, pieceType, { row, col });
      }
      selected = null;
      render();
      maybeTriggerCpuTurn();
      return;
    }
    selected = null;
  }

  if (piece && piece.owner === 'sente') {
    selected = { kind: 'board', row, col };
  }
  render();
}

function onHandPieceClick(index) {
  if (!state || state.winner || state.turn !== 'sente' || cpuThinking) return;
  if (selected && selected.kind === 'hand' && selected.index === index) {
    selected = null;
  } else {
    selected = { kind: 'hand', index };
  }
  render();
}

/**
 * CPU(gote)の一手を選ぶ。学習モード中は難易度に関係なく定跡区間なら定跡を優先し、
 * ゾウ冠の手順をプレイヤーに見せる(通常は選んだ難易度ティアのbook設定に従う)。
 */
function pickCpuMove() {
  if (learningMode) {
    const book = CpuAI.bookMoveForHistory(moveHistory);
    if (book) return book.move;
  }
  return CpuAI.chooseMove(GameLogic, state, difficulty, moveHistory);
}

/** state.turn が gote(CPU)になったら、少し「考える」演出を挟んでCPUに指させる */
function maybeTriggerCpuTurn() {
  if (!state || state.winner || state.turn !== 'gote') return;
  cpuThinking = true;
  render();
  const startedAt = Date.now();
  // メインスレッドを長時間ブロックしないよう、思考自体は次のイベントループで実行する
  setTimeout(() => {
    const move = pickCpuMove();
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, CPU_THINK_MIN_MS - elapsed);
    setTimeout(() => {
      if (move) {
        moveHistory.push(move);
        state = move.kind === 'move'
          ? GameLogic.movePiece(state, move.from, move.to)
          : GameLogic.dropPiece(state, move.pieceType, move.to);
      }
      cpuThinking = false;
      render();
    }, wait);
  }, 30);
}

function setupEvents() {
  buildDifficultyGrid();
  el('change-difficulty-btn').addEventListener('click', () => {
    state = null;
    selected = null;
    cpuThinking = false;
    el('game-screen').classList.add('hidden');
    el('select-screen').classList.remove('hidden');
  });
  el('retry-btn').addEventListener('click', () => startGame(difficulty));
}

setupEvents();
