// CPU練習モード: Firebase不要のローカル対局。プレイヤーは常に先手、CPUは常に後手。

const PIECE_EMOJI = {
  lion: '🦁',
  elephant: '🐘',
  giraffe: '🦒',
  chick: '🐤',
  hen: '🐔',
};

const DIFFICULTY_LABEL = { easy: 'かんたん', normal: 'ふつう', hard: 'つよい' };
const CPU_THINK_MIN_MS = 450; // 一瞬で指すと不自然なので最低これだけ「考える」演出を入れる

let state = null;
let difficulty = null;
let selected = null; // { kind: 'board', row, col } | { kind: 'hand', index }
let cpuThinking = false;

const el = (id) => document.getElementById(id);

function startGame(diff) {
  difficulty = diff;
  state = GameLogic.createInitialState();
  selected = null;
  cpuThinking = false;
  el('difficulty-display').textContent = DIFFICULTY_LABEL[diff];
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

  renderBoard();
  renderHand('sente');
  renderHand('gote');
}

function renderBoard() {
  const boardEl = el('board');
  boardEl.innerHTML = '';

  const legalDests = getLegalDestinationsForSelection();
  const myTurnActive = !state.winner && state.turn === 'sente' && !cpuThinking;
  const last = state.lastMove;

  const ownReachableForHover = myTurnActive;

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
        state = GameLogic.movePiece(state, { row: selected.row, col: selected.col }, { row, col });
      } else {
        const pieceType = state.hands.sente[selected.index];
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

/** state.turn が gote(CPU)になったら、少し「考える」演出を挟んでCPUに指させる */
function maybeTriggerCpuTurn() {
  if (!state || state.winner || state.turn !== 'gote') return;
  cpuThinking = true;
  render();
  const startedAt = Date.now();
  // メインスレッドを長時間ブロックしないよう、思考自体は次のイベントループで実行する
  setTimeout(() => {
    const move = CpuAI.chooseMove(GameLogic, state, difficulty);
    const elapsed = Date.now() - startedAt;
    const wait = Math.max(0, CPU_THINK_MIN_MS - elapsed);
    setTimeout(() => {
      if (move) {
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
  document.querySelectorAll('.difficulty-btn').forEach((btn) => {
    btn.addEventListener('click', () => startGame(btn.dataset.difficulty));
  });
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
