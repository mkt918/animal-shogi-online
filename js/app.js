// アプリ本体: Firebase接続、ロビー/対戦画面の制御、盤面描画、操作処理

const PIECE_EMOJI = {
  lion: '🦁',
  elephant: '🐘',
  giraffe: '🦒',
  chick: '🐤',
  hen: '🐔',
};

let app, auth, db;
let uid = null;
let roomCode = null;
let unsubscribeRoom = null;
let myRole = null; // 'sente' | 'gote' | 'spectator'
let selected = null; // { kind: 'board', row, col } | { kind: 'hand', pieceType }
let currentGameDoc = null;

const el = (id) => document.getElementById(id);

// Firestoreはネストした配列(2次元配列)を保存できないため、board を保存用にフラット化する。
function serializeState(state) {
  const flatBoard = [];
  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      flatBoard.push(state.board[r][c]);
    }
  }
  return { ...state, board: flatBoard };
}

function deserializeState(stored) {
  const board = [];
  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    const row = [];
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      row.push(stored.board[r * GameLogic.BOARD_COLS + c] || null);
    }
    board.push(row);
  }
  return { ...stored, board };
}

function initFirebase() {
  try {
    app = firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
  } catch (e) {
    el('connection-status').textContent = 'Firebase初期化エラー: js/firebase-config.js を設定してください。';
    console.error(e);
    return;
  }

  auth.signInAnonymously().catch((err) => {
    el('connection-status').textContent = 'ログインエラー: ' + err.message;
    console.error(err);
  });

  auth.onAuthStateChanged((user) => {
    if (user) {
      uid = user.uid;
      el('connection-status').textContent = '接続完了。部屋を作るか、部屋コードを入力してください。';
      el('create-room-btn').disabled = false;
      el('join-room-btn').disabled = false;
      checkUrlForRoom();
    }
  });
}

function checkUrlForRoom() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  if (code) {
    el('room-code-input').value = code.toUpperCase();
    joinRoom(code.toUpperCase());
  }
}

function generateRoomCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

async function createRoom() {
  el('lobby-error').textContent = '';
  const code = generateRoomCode();
  const state = GameLogic.createInitialState();
  try {
    await db.collection('games').doc(code).set({
      state: serializeState(state),
      players: { sente: uid, gote: null },
      status: 'waiting',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    enterRoom(code);
  } catch (e) {
    el('lobby-error').textContent = '部屋の作成に失敗しました: ' + e.message;
    console.error(e);
  }
}

async function joinRoom(code) {
  el('lobby-error').textContent = '';
  if (!code || code.length < 4) {
    el('lobby-error').textContent = '部屋コードを入力してください。';
    return;
  }
  const ref = db.collection('games').doc(code);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('その部屋は存在しません。');
      const data = doc.data();
      if (data.players.sente === uid || data.players.gote === uid) {
        return; // 既に参加済み(再入室)
      }
      if (data.players.gote) {
        throw new Error('部屋は満員です。');
      }
      tx.update(ref, { 'players.gote': uid, status: 'playing' });
    });
    enterRoom(code);
  } catch (e) {
    el('lobby-error').textContent = e.message;
    console.error(e);
  }
}

function enterRoom(code) {
  roomCode = code;
  el('lobby-screen').classList.add('hidden');
  el('game-screen').classList.remove('hidden');
  el('room-code-display').textContent = code;

  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  window.history.replaceState({}, '', url);

  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = db.collection('games').doc(code).onSnapshot((doc) => {
    if (!doc.exists) return;
    currentGameDoc = doc.data();
    currentGameDoc.state = deserializeState(currentGameDoc.state);
    determineRole();
    selected = null;
    render();
  }, (err) => {
    console.error(err);
    el('lobby-error').textContent = '接続エラー: ' + err.message;
  });
}

function determineRole() {
  if (!currentGameDoc) return;
  if (currentGameDoc.players.sente === uid) myRole = 'sente';
  else if (currentGameDoc.players.gote === uid) myRole = 'gote';
  else myRole = 'spectator';
}

function leaveRoom() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = null;
  roomCode = null;
  currentGameDoc = null;
  myRole = null;
  selected = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
  el('game-screen').classList.add('hidden');
  el('lobby-screen').classList.remove('hidden');
}

async function pushState(newState) {
  try {
    await db.collection('games').doc(roomCode).update({ state: serializeState(newState) });
  } catch (e) {
    console.error(e);
    alert('通信エラーが発生しました: ' + e.message);
  }
}

function render() {
  if (!currentGameDoc) return;
  const { state, players, status } = currentGameDoc;

  const roleEl = el('player-role');
  roleEl.classList.remove('role-sente', 'role-gote', 'role-spectator');
  if (myRole === 'sente') {
    roleEl.innerHTML = 'あなたは<strong>先手</strong>';
    roleEl.classList.add('role-sente');
  } else if (myRole === 'gote') {
    roleEl.innerHTML = 'あなたは<strong>後手</strong>';
    roleEl.classList.add('role-gote');
  } else {
    roleEl.textContent = '観戦中';
    roleEl.classList.add('role-spectator');
  }
  el('waiting-msg').classList.toggle('hidden', status !== 'waiting');

  if (state.winner) {
    const winnerLabel = state.winner === 'sente' ? '先手' : '後手';
    const reasonLabel = state.winReason === 'try' ? 'トライ' : 'ライオン捕獲';
    const resultEl = el('result-msg');
    const wasHidden = resultEl.classList.contains('hidden');
    resultEl.textContent = `${winnerLabel}の勝ち!(${reasonLabel})`;
    resultEl.classList.remove('hidden');
    if (wasHidden) {
      const burst = document.createElement('span');
      burst.className = 'star-burst';
      resultEl.appendChild(burst);
      burst.addEventListener('animationend', () => burst.remove());
    }
    el('turn-indicator').textContent = '対局終了';
  } else {
    el('result-msg').classList.add('hidden');
    const turnLabel = state.turn === 'sente' ? '先手' : '後手';
    const isMyTurn = myRole === state.turn;
    el('turn-indicator').textContent = `${turnLabel}の番です${isMyTurn ? '(あなたの番)' : ''}`;
  }

  // 後手番でプレイしている間は、自分の駒が手前(下)に来るよう盤面と持ち駒を反転表示する
  const orientation = myRole === 'gote' ? 'gote' : 'sente';
  el('game-area').classList.toggle('flipped', orientation === 'gote');

  renderBoard(state, orientation);
  renderHand('sente', state, orientation);
  renderHand('gote', state, orientation);
}

function renderBoard(state, orientation) {
  const boardEl = el('board');
  boardEl.innerHTML = '';

  const legalDests = getLegalDestinationsForSelection(state);
  const myTurnActive = !state.winner && myRole === state.turn;

  // 選択していない間も、自分の駒それぞれが動ける先を薄いドットで常時表示する
  const ownReachable = [];
  if (myTurnActive && !selected) {
    for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
      for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
        const p = state.board[r][c];
        if (p && p.owner === myRole) {
          ownReachable.push(...GameLogic.getPieceDestinations(state, r, c));
        }
      }
    }
  }

  // orientation が gote のときは表示順を180度反転する(データ上のrow/colは変えない)
  const rowOrder = orientation === 'gote'
    ? [...Array(GameLogic.BOARD_ROWS).keys()].reverse()
    : [...Array(GameLogic.BOARD_ROWS).keys()];
  const colOrder = orientation === 'gote'
    ? [...Array(GameLogic.BOARD_COLS).keys()].reverse()
    : [...Array(GameLogic.BOARD_COLS).keys()];

  rowOrder.forEach((r) => {
    colOrder.forEach((c) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      const piece = state.board[r][c];
      if (piece) {
        const pieceEl = document.createElement('div');
        const rotated = piece.owner !== orientation;
        pieceEl.className = `piece owner-${piece.owner}${rotated ? ' piece-rotated' : ''}`;
        pieceEl.innerHTML = `<span class="emoji">${PIECE_EMOJI[piece.type]}</span><span>${GameLogic.PIECE_NAMES[piece.type]}</span>`;
        cell.appendChild(pieceEl);
      }

      if (selected && selected.kind === 'board' && selected.row === r && selected.col === c) {
        cell.classList.add('selected');
      }
      if (legalDests.some((d) => d.row === r && d.col === c)) {
        cell.classList.add('destination');
      }
      if (ownReachable.some((d) => d.row === r && d.col === c)) {
        cell.classList.add('reachable-preview');
      }

      cell.addEventListener('click', () => onCellClick(r, c));
      boardEl.appendChild(cell);
    });
  });
}

function renderHand(owner, state, orientation) {
  const container = el(`hand-${owner}-pieces`);
  container.innerHTML = '';
  const canInteract = myRole === owner && myRole === state.turn && !state.winner;

  state.hands[owner].forEach((pieceType, idx) => {
    const pieceEl = document.createElement('div');
    pieceEl.className = 'hand-piece' + (canInteract ? '' : ' disabled');
    pieceEl.textContent = PIECE_EMOJI[pieceType];
    pieceEl.title = GameLogic.PIECE_NAMES[pieceType];
    if (selected && selected.kind === 'hand' && selected.owner === owner && selected.index === idx) {
      pieceEl.classList.add('selected');
    }
    if (canInteract) {
      pieceEl.addEventListener('click', () => onHandPieceClick(owner, idx, pieceType));
      pieceEl.addEventListener('mouseenter', () => onHandPieceMouseEnter(state));
      pieceEl.addEventListener('mouseleave', onHandPieceMouseLeave);
    }
    container.appendChild(pieceEl);
  });
}

function getLegalDestinationsForSelection(state) {
  if (!selected) return [];
  if (selected.kind === 'board') {
    return GameLogic.getPieceDestinations(state, selected.row, selected.col);
  }
  if (selected.kind === 'hand') {
    return GameLogic.getDropDestinations(state);
  }
  return [];
}

function onCellClick(row, col) {
  if (!currentGameDoc) return;
  const { state } = currentGameDoc;
  if (state.winner) return;
  if (myRole !== state.turn) return;

  const piece = state.board[row][col];

  if (selected) {
    const dests = getLegalDestinationsForSelection(state);
    const isLegal = dests.some((d) => d.row === row && d.col === col);
    if (isLegal) {
      let newState;
      if (selected.kind === 'board') {
        newState = GameLogic.movePiece(state, { row: selected.row, col: selected.col }, { row, col });
      } else {
        const pieceType = state.hands[myRole][selected.index];
        newState = GameLogic.dropPiece(state, pieceType, { row, col });
      }
      selected = null;
      pushState(newState);
      return;
    }
    // 選択し直し
    selected = null;
  }

  if (piece && piece.owner === myRole) {
    selected = { kind: 'board', row, col };
  }
  render();
}

function onHandPieceMouseEnter(state) {
  if (!currentGameDoc || selected) return;
  const dests = GameLogic.getDropDestinations(state);
  dests.forEach((d) => {
    const cellEl = document.querySelector(`.cell[data-row="${d.row}"][data-col="${d.col}"]`);
    if (cellEl) cellEl.classList.add('reachable-preview');
  });
}

function onHandPieceMouseLeave() {
  document.querySelectorAll('.cell.reachable-preview').forEach((c) => c.classList.remove('reachable-preview'));
  if (currentGameDoc && !selected) renderBoard(currentGameDoc.state);
}

function onHandPieceClick(owner, index, pieceType) {
  if (!currentGameDoc) return;
  const { state } = currentGameDoc;
  if (state.winner || myRole !== state.turn || owner !== myRole) return;

  if (selected && selected.kind === 'hand' && selected.index === index) {
    selected = null;
  } else {
    selected = { kind: 'hand', owner, index, pieceType };
  }
  render();
}

function setupUIEvents() {
  el('create-room-btn').addEventListener('click', createRoom);
  el('join-room-btn').addEventListener('click', () => {
    const code = el('room-code-input').value.trim().toUpperCase();
    joinRoom(code);
  });
  el('room-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('join-room-btn').click();
  });
  el('leave-room-btn').addEventListener('click', leaveRoom);
  el('copy-link-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      el('copy-link-btn').textContent = 'コピーしました!';
      setTimeout(() => { el('copy-link-btn').textContent = 'リンクをコピー'; }, 1500);
    });
  });
}

setupUIEvents();
initFirebase();
