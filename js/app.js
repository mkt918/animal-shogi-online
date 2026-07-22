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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function createRoom() {
  el('lobby-error').textContent = '';
  const code = generateRoomCode();
  const state = GameLogic.createInitialState();
  try {
    await db.collection('games').doc(code).set({
      state,
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
    await db.collection('games').doc(roomCode).update({ state: newState });
  } catch (e) {
    console.error(e);
    alert('通信エラーが発生しました: ' + e.message);
  }
}

function render() {
  if (!currentGameDoc) return;
  const { state, players, status } = currentGameDoc;

  el('player-role').textContent = myRole === 'sente' ? 'あなたは先手' : myRole === 'gote' ? 'あなたは後手' : '観戦中';
  el('waiting-msg').classList.toggle('hidden', status !== 'waiting');

  if (state.winner) {
    const winnerLabel = state.winner === 'sente' ? '先手' : '後手';
    const reasonLabel = state.winReason === 'try' ? 'トライ' : 'ライオン捕獲';
    el('result-msg').textContent = `${winnerLabel}の勝ち!(${reasonLabel})`;
    el('result-msg').classList.remove('hidden');
    el('turn-indicator').textContent = '対局終了';
  } else {
    el('result-msg').classList.add('hidden');
    const turnLabel = state.turn === 'sente' ? '先手' : '後手';
    const isMyTurn = myRole === state.turn;
    el('turn-indicator').textContent = `${turnLabel}の番です${isMyTurn ? '(あなたの番)' : ''}`;
  }

  renderBoard(state);
  renderHand('sente', state);
  renderHand('gote', state);
}

function renderBoard(state) {
  const boardEl = el('board');
  boardEl.innerHTML = '';

  const legalDests = getLegalDestinationsForSelection(state);

  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      const piece = state.board[r][c];
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = `piece owner-${piece.owner}`;
        pieceEl.innerHTML = `<span class="emoji">${PIECE_EMOJI[piece.type]}</span><span>${GameLogic.PIECE_NAMES[piece.type]}</span>`;
        cell.appendChild(pieceEl);
      }

      if (selected && selected.kind === 'board' && selected.row === r && selected.col === c) {
        cell.classList.add('selected');
      }
      if (legalDests.some((d) => d.row === r && d.col === c)) {
        cell.classList.add('destination');
      }

      cell.addEventListener('click', () => onCellClick(r, c));
      boardEl.appendChild(cell);
    }
  }
}

function renderHand(owner, state) {
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
      setTimeout(() => { el('copy-link-btn').textContent = '🔗リンクをコピー'; }, 1500);
    });
  });
}

setupUIEvents();
initFirebase();
