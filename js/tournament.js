// 大会モード: 大会の作成/参加、組み合わせ生成、対局の開始、順位表の表示

let db, uid = null;
let tCode = null;
let tDoc = null;
let unsubscribeT = null;

const el = (id) => document.getElementById(id);

// Firestore の TTL ポリシーが参照する有効期限(README「古いドキュメントの自動削除」参照)
const TOURNAMENT_TTL_DAYS = 30;
const GAME_TTL_DAYS = 7;
function expiresAfterDays(days) {
  return firebase.firestore.Timestamp.fromMillis(Date.now() + days * 24 * 60 * 60 * 1000);
}
const NAME_KEY = 'animal-shogi-player-name';

function showError(msg) {
  el('t-error').textContent = msg || '';
}

function savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; }
}
function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch (_) { /* ignore */ }
}

function generateCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

// app.js と同じ形式で盤面をフラット化(Firestoreはネスト配列不可)
function serializeState(state) {
  const flat = [];
  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) flat.push(state.board[r][c]);
  }
  return { ...state, board: flat };
}

function init() {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  } catch (e) {
    el('connection-status').textContent = 'Firebase初期化エラー';
    console.error(e);
    return;
  }
  firebase.auth().signInAnonymously().catch((err) => {
    el('connection-status').textContent = 'ログインエラー: ' + err.message;
  });
  firebase.auth().onAuthStateChanged((user) => {
    if (!user) return;
    uid = user.uid;
    el('connection-status').classList.add('hidden');
    el('host-name').value = savedName();
    el('join-name').value = savedName();
    const code = new URLSearchParams(location.search).get('code');
    if (code) {
      el('t-code-input').value = code;
      openTournament(code);
    } else {
      el('t-entry').classList.remove('hidden');
    }
  });
}

async function createTournament() {
  showError('');
  const name = el('host-name').value.trim();
  if (!name) { showError('名前を入力してください。'); return; }
  rememberName(name);
  const format = el('format-select').value;
  try {
    // 4桁コードは衝突しうるので、存在しないコードを引くまで再試行する(既存の大会を上書きしない)
    let code = null;
    for (let attempt = 0; attempt < 10 && !code; attempt++) {
      const candidate = generateCode();
      const ref = db.collection('tournaments').doc(candidate);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return;
        tx.set(ref, {
          format,
          hostUid: uid,
          status: 'lobby',
          players: [{ uid, name }],
          playerUids: [uid], // セキュリティルールで「参加者本人か」を判定するための一覧
          matches: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAfterDays(TOURNAMENT_TTL_DAYS),
        });
        code = candidate;
      });
    }
    if (!code) throw new Error('空いている大会コードが見つかりませんでした。もう一度お試しください。');
    openTournament(code);
  } catch (e) {
    showError('大会の作成に失敗しました: ' + e.message);
    console.error(e);
  }
}

async function joinTournament(code, name) {
  showError('');
  if (!code || code.length !== 4) { showError('大会コード(4桁)を入力してください。'); return; }
  if (!name) { showError('名前を入力してください。'); return; }
  rememberName(name);
  const ref = db.collection('tournaments').doc(code);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('その大会は存在しません。');
      const t = snap.data();
      if (t.players.some((p) => p.uid === uid)) return; // 再入室
      if (t.status !== 'lobby') throw new Error('この大会はすでに始まっています。');
      if (t.players.some((p) => p.name === name)) throw new Error('同じ名前の参加者がいます。別の名前にしてください。');
      tx.update(ref, {
        players: [...t.players, { uid, name }],
        playerUids: [...(t.playerUids || t.players.map((p) => p.uid)), uid],
      });
    });
    openTournament(code);
  } catch (e) {
    showError(e.message);
    console.error(e);
  }
}

function openTournament(code) {
  tCode = code;
  const url = new URL(location.href);
  url.searchParams.set('code', code);
  history.replaceState({}, '', url);

  if (unsubscribeT) unsubscribeT();
  unsubscribeT = db.collection('tournaments').doc(code).onSnapshot((snap) => {
    if (!snap.exists) {
      showError('その大会は存在しません。');
      el('t-entry').classList.remove('hidden');
      el('t-screen').classList.add('hidden');
      return;
    }
    tDoc = snap.data();
    const isMember = tDoc.players.some((p) => p.uid === uid);
    if (!isMember && tDoc.status === 'lobby') {
      // 未参加なら参加フォームを出す(コードは入力済み)
      el('t-entry').classList.remove('hidden');
      el('t-screen').classList.add('hidden');
      el('t-code-input').value = code;
      return;
    }
    el('t-entry').classList.add('hidden');
    el('t-screen').classList.remove('hidden');
    render();
  }, (err) => {
    console.error(err);
    showError('接続エラー: ' + err.message);
  });
}

async function startTournament() {
  if (!tDoc || tDoc.hostUid !== uid) return;
  if (tDoc.players.length < 2) { showError('2人以上必要です。'); return; }
  const uids = tDoc.players.map((p) => p.uid);
  const matches = tDoc.format === 'knockout'
    ? TournamentLogic.generateKnockout(uids)
    : TournamentLogic.generateRoundRobin(uids);
  try {
    await db.collection('tournaments').doc(tCode).update({ matches, status: 'running' });
  } catch (e) {
    showError('開始に失敗しました: ' + e.message);
  }
}

/** 対局を開始する。押した人が先手になり、games ドキュメントを作って対局画面へ移動する。 */
async function startMatch(match) {
  if (!match.p1 || !match.p2) return; // トーナメントで対戦相手がまだ決まっていない
  const opponent = match.p1 === uid ? match.p2 : match.p1;
  // 大会の対局は参加者名が分かっているので、対局画面/観戦者向けに名前も持たせる
  const myName = nameOf(uid);
  const opponentName = nameOf(opponent);
  const tRef = db.collection('tournaments').doc(tCode);
  try {
    let gameCode = null;
    // 部屋コードが既存の対局と衝突したら別のコードで作り直す(既存の部屋を上書きしない)
    for (let attempt = 0; attempt < 10 && !gameCode; attempt++) {
      const candidate = generateCode();
      const gRef = db.collection('games').doc(candidate);
      await db.runTransaction(async (tx) => {
        const [tSnap, gSnap] = await Promise.all([tx.get(tRef), tx.get(gRef)]);
        if (!tSnap.exists) throw new Error('大会が見つかりません。');
        if (gSnap.exists) return; // コード衝突 → 次の候補へ
        const t = tSnap.data();
        const matches = t.matches.map((m) => ({ ...m }));
        const m = matches.find((x) => x.id === match.id);
        if (!m) throw new Error('対局が見つかりません。');
        if (m.gameId) throw new Error('already-started:' + m.gameId);
        m.gameId = candidate;
        tx.set(gRef, {
          state: serializeState(GameLogic.createInitialState()),
          players: { sente: uid, gote: null },
          names: { sente: myName, gote: opponentName },
          status: 'waiting',
          tournamentId: tCode,
          matchId: match.id,
          expectedGote: opponent,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: expiresAfterDays(GAME_TTL_DAYS),
        });
        tx.update(tRef, { matches });
        gameCode = candidate;
      });
    }
    if (!gameCode) throw new Error('空いている部屋コードが見つかりませんでした。もう一度お試しください。');
    location.href = `index.html?room=${gameCode}`;
  } catch (e) {
    if (String(e.message).startsWith('already-started:')) {
      location.href = `index.html?room=${e.message.split(':')[1]}`;
      return;
    }
    showError('対局の作成に失敗しました: ' + e.message);
    console.error(e);
  }
}

function nameOf(pid) {
  if (!pid) return tDoc.format === 'knockout' ? '(未定)' : '(休み)';
  const p = tDoc.players.find((x) => x.uid === pid);
  return p ? p.name : '?';
}

function render() {
  const t = tDoc;
  el('t-code-display').textContent = tCode;
  el('t-player-count').textContent = `${t.players.length}人`;

  const isHost = t.hostUid === uid;
  const isMember = t.players.some((p) => p.uid === uid);

  const badge = el('t-status-badge');
  badge.className = 'status-badge status-badge--' + t.status;
  const statusLabel = { lobby: '参加受付中', running: '対局中', finished: '終了' }[t.status] || t.status;
  badge.textContent = isMember ? statusLabel : `${statusLabel}(観戦中)`;

  el('t-host-controls').classList.toggle('hidden', !(isHost && t.status === 'lobby'));
  el('t-wait-msg').classList.toggle('hidden', !(isMember && !isHost && t.status === 'lobby'));
  el('delete-t-btn').classList.toggle('hidden', !isHost); // 後片付けは主催者だけ

  // 参加者
  const list = el('t-players');
  list.innerHTML = '';
  t.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name;
    if (p.uid === t.hostUid) li.appendChild(makeTag('主催'));
    if (p.uid === uid) li.appendChild(makeTag('あなた', 'tag--me'));
    list.appendChild(li);
  });

  const started = t.status !== 'lobby';
  const isKnockout = t.format === 'knockout';
  el('t-standings-card').classList.toggle('hidden', !started || isKnockout);
  el('t-schedule-card').classList.toggle('hidden', !started);
  el('t-schedule-title').textContent = isKnockout ? '勝ち上がり表' : '対局表';
  el('t-footer-note').textContent = isKnockout
    ? 'トーナメント: 負けたら終了(シングルエリミネーション)。引き分けの対局はもう一度同じ相手と対局します。'
    : 'リーグ戦: 勝ち3点・引き分け1点。対局が終わると自動で順位表に反映されます。';
  if (!started) {
    el('t-champion').classList.add('hidden');
    return;
  }

  if (isKnockout) {
    renderChampion(t);
  } else {
    el('t-champion').classList.add('hidden');
    renderStandings(t);
  }
  renderSchedule(t);
  syncWatchMode(t);
}

function renderChampion(t) {
  const el2 = el('t-champion');
  if (t.status !== 'finished') {
    el2.classList.add('hidden');
    return;
  }
  const final = t.matches.find((m) => !m.nextMatchId);
  const championName = final && final.winner ? nameOf(final.winner) : null;
  if (!championName) {
    el2.classList.add('hidden');
    return;
  }
  el2.textContent = final.winner === uid ? `優勝!おめでとうございます、${championName}さん 🏆` : `優勝: ${championName} 🏆`;
  el2.classList.remove('hidden');
}

function makeTag(text, extraClass) {
  const s = document.createElement('span');
  s.className = 'tag' + (extraClass ? ' ' + extraClass : '');
  s.textContent = text;
  return s;
}

function renderStandings(t) {
  const rows = TournamentLogic.computeStandings(t.players, t.matches);
  const table = el('t-standings');
  table.innerHTML = '<thead><tr><th>順位</th><th>名前</th><th>点</th><th>勝</th><th>分</th><th>負</th></tr></thead>';
  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    if (r.uid === uid) tr.className = 'me';
    const cells = [r.rank, r.name, r.points, r.win, r.draw, r.loss];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      if (i !== 1) td.className = 'mono-num';
      if (i === 2) {
        const b = document.createElement('strong');
        b.textContent = v;
        td.appendChild(b);
      } else {
        td.textContent = v;
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

function renderSchedule(t) {
  const container = el('t-rounds');
  container.innerHTML = '';
  const isKnockout = t.format === 'knockout';
  const rounds = [...new Set(t.matches.map((m) => m.round))].sort((a, b) => a - b);
  const totalRounds = Math.max(...rounds);

  if (isKnockout) {
    container.appendChild(renderBracket(t, rounds, totalRounds));
    return;
  }

  rounds.forEach((r) => {
    const sec = document.createElement('div');
    sec.className = 'round';
    const h = document.createElement('h4');
    h.textContent = isKnockout ? TournamentLogic.knockoutRoundLabel(r, totalRounds) : `第${r}回戦`;
    sec.appendChild(h);
    const inRound = t.matches.filter((m) => m.round === r);
    inRound.forEach((m) => sec.appendChild(renderMatch(m)));

    if (!isKnockout) {
      // このラウンドで休みの人(リーグ戦のみ)
      const playing = new Set(inRound.flatMap((m) => [m.p1, m.p2]));
      const resting = t.players.filter((p) => !playing.has(p.uid));
      if (resting.length) {
        const p = document.createElement('p');
        p.className = 'rest-note';
        p.textContent = `休み: ${resting.map((x) => x.name).join('、')}`;
        sec.appendChild(p);
      }
    }
    container.appendChild(sec);
  });
}

/**
 * トーナメント表(ブラケット図)を描く。
 * ラウンドごとに縦一列に並べ、1回戦の2試合が2回戦の1試合へつながる形を
 * CSS の枠線で表現する。勝ち上がった側の名前には印を付ける。
 */
function renderBracket(t, rounds, totalRounds) {
  const bracket = document.createElement('div');
  bracket.className = 'bracket';

  rounds.forEach((r) => {
    const col = document.createElement('div');
    col.className = 'bracket-round';

    const head = document.createElement('h4');
    head.textContent = TournamentLogic.knockoutRoundLabel(r, totalRounds);
    col.appendChild(head);

    const body = document.createElement('div');
    body.className = 'bracket-matches';
    t.matches.filter((m) => m.round === r).forEach((m) => body.appendChild(renderBracketMatch(m)));
    col.appendChild(body);
    bracket.appendChild(col);
  });

  // 優勝者の枠(決勝の勝者)
  const finalMatch = t.matches.find((m) => !m.nextMatchId);
  const champCol = document.createElement('div');
  champCol.className = 'bracket-round bracket-round--champion';
  const champHead = document.createElement('h4');
  champHead.textContent = '優勝';
  champCol.appendChild(champHead);
  const champBox = document.createElement('div');
  champBox.className = 'bracket-champion';
  if (finalMatch && finalMatch.winner && finalMatch.winner !== 'draw') {
    champBox.classList.add('bracket-champion--decided');
    champBox.textContent = `🏆 ${nameOf(finalMatch.winner)}`;
  } else {
    champBox.textContent = '未定';
  }
  champCol.appendChild(champBox);
  bracket.appendChild(champCol);

  return bracket;
}

/** ブラケット図の1試合分(対戦者2人を縦に並べた枠) */
function renderBracketMatch(m) {
  const box = document.createElement('div');
  box.className = 'bracket-match';
  const mine = m.p1 === uid || m.p2 === uid;
  if (mine) box.classList.add('bracket-match--mine');

  ['p1', 'p2'].forEach((slot) => {
    const pid = m[slot];
    const row = document.createElement('div');
    row.className = 'bracket-slot';
    if (m.winner && m.winner !== 'draw' && pid && m.winner === pid) row.classList.add('bracket-slot--winner');
    if (pid && pid === uid) row.classList.add('bracket-slot--me');
    if (!pid) row.classList.add('bracket-slot--empty');

    const name = document.createElement('span');
    name.className = 'bracket-slot-name';
    name.textContent = opponentLabel(m, pid);
    row.appendChild(name);
    box.appendChild(row);
  });

  const action = document.createElement('div');
  action.className = 'bracket-action';
  action.appendChild(matchActionElement(m, mine));
  box.appendChild(action);
  return box;
}

/** 対局表・ブラケット図で共通して使う「状態と操作」の要素 */
function matchActionElement(m, mine) {
  const bothDecided = m.p1 !== null && m.p2 !== null;
  if (m.winner) {
    const isBye = tDoc.format === 'knockout' && m.round === 1 && (!m.p1 || !m.p2);
    return makeTag(
      m.winner === 'draw' ? '引き分け' : isBye ? '不戦勝で進出' : `${nameOf(m.winner)}の勝ち`,
      'tag--done',
    );
  }
  if (!bothDecided) return makeTag('未定');
  if (m.gameId) {
    const wrap = document.createElement('span');
    wrap.className = 'match-action';
    const a = document.createElement('a');
    a.className = 'btn btn--sm ' + (mine ? 'btn--cyan' : 'btn--outline');
    a.href = `index.html?room=${m.gameId}`;
    a.textContent = mine ? '対局に参加' : '観戦';
    wrap.appendChild(a);
    wrap.appendChild(makeTag('対局中'));
    return wrap;
  }
  if (mine && tDoc.status === 'running') {
    const b = document.createElement('button');
    b.className = 'btn btn--sm btn--pear';
    b.textContent = '対局を始める';
    b.addEventListener('click', () => startMatch(m));
    return b;
  }
  return makeTag('未対局');
}

/** 対局中の名前欄に出す表示。トーナメントで枠が null のときは「不戦勝」か「未定」かを区別する。 */
function opponentLabel(m, pid) {
  if (pid) return nameOf(pid);
  if (tDoc.format === 'knockout' && m.round === 1 && m.winner) return '(不戦勝)';
  return nameOf(null);
}

function renderMatch(m) {
  const row = document.createElement('div');
  row.className = 'match';
  const bothDecided = m.p1 !== null && m.p2 !== null;
  const mine = bothDecided && (m.p1 === uid || m.p2 === uid);
  if (mine) row.classList.add('match--mine');

  const names = document.createElement('div');
  names.className = 'match-names';
  const n1 = document.createElement('span'); n1.textContent = opponentLabel(m, m.p1);
  const vs = document.createElement('span'); vs.className = 'vs'; vs.textContent = 'vs';
  const n2 = document.createElement('span'); n2.textContent = opponentLabel(m, m.p2);
  if (m.winner && m.winner !== 'draw') {
    (m.winner === m.p1 ? n1 : n2).classList.add('winner');
  }
  names.append(n1, vs, n2);
  row.appendChild(names);

  const action = document.createElement('div');
  action.className = 'match-action';
  action.appendChild(matchActionElement(m, mine));
  row.appendChild(action);
  return row;
}

/**
 * 主催者による大会の削除。ぶら下がっている対局(games)も一緒に片付ける。
 * 取り消せない操作なので、大会コードを打ち込んでもらって確認する。
 */
async function deleteTournament() {
  if (!tDoc || tDoc.hostUid !== uid) return;
  const answer = window.prompt(
    `この大会(コード ${tCode})を削除します。取り消せません。\n`
    + '削除してよければ、大会コードを入力してください。',
  );
  if (answer === null) return; // キャンセル
  if (answer.trim() !== tCode) {
    showError('大会コードが一致しないため削除を中止しました。');
    return;
  }

  const gameIds = (tDoc.matches || []).map((m) => m.gameId).filter(Boolean);
  try {
    // 先に対局を消す(大会が先に消えるとルール側で主催者判定ができなくなるため)
    for (const gameId of gameIds) {
      try {
        await db.collection('games').doc(gameId).delete();
      } catch (e) {
        console.warn('対局の削除をスキップしました', gameId, e.message);
      }
    }
    await db.collection('tournaments').doc(tCode).delete();

    if (unsubscribeT) unsubscribeT();
    unsubscribeT = null;
    stopWatchMode();
    tDoc = null;
    tCode = null;
    const url = new URL(location.href);
    url.searchParams.delete('code');
    history.replaceState({}, '', url);
    el('t-screen').classList.add('hidden');
    el('t-entry').classList.remove('hidden');
    showError('大会を削除しました。');
  } catch (e) {
    showError('削除に失敗しました: ' + e.message);
    console.error(e);
  }
}

// --- 一覧観戦モード: 進行中の対局の盤面をまとめて表示する ---
const watchUnsubscribers = new Map(); // gameId → onSnapshot の解除関数
const watchStates = new Map(); // gameId → 対局ドキュメント

function stopWatchMode() {
  watchUnsubscribers.forEach((unsub) => unsub());
  watchUnsubscribers.clear();
  watchStates.clear();
  el('t-watch-boards').innerHTML = '';
}

/** 対局表の状態に合わせて、購読する対局を増減させる */
function syncWatchMode(t) {
  const enabled = el('watch-mode-toggle').checked;
  const started = t.status !== 'lobby';
  el('t-watch-card').classList.toggle('hidden', !started);

  // 「始まっているが、まだ決着していない」対局が観戦対象
  const liveIds = enabled
    ? (t.matches || []).filter((m) => m.gameId && !m.winner).map((m) => m.gameId)
    : [];
  el('t-watch-count').textContent = enabled ? `${liveIds.length}局` : '';
  el('t-watch-empty').classList.toggle('hidden', !enabled || liveIds.length > 0);
  el('t-watch-empty').textContent = enabled
    ? 'いま進行中の対局はありません。'
    : '';

  if (!enabled) {
    stopWatchMode();
    return;
  }

  // 終わった/消えた対局の購読をやめる
  watchUnsubscribers.forEach((unsub, gameId) => {
    if (!liveIds.includes(gameId)) {
      unsub();
      watchUnsubscribers.delete(gameId);
      watchStates.delete(gameId);
    }
  });

  // 新しく始まった対局を購読する
  liveIds.forEach((gameId) => {
    if (watchUnsubscribers.has(gameId)) return;
    const unsub = db.collection('games').doc(gameId).onSnapshot((snap) => {
      if (!snap.exists) {
        watchStates.delete(gameId);
      } else {
        watchStates.set(gameId, snap.data());
      }
      renderWatchBoards();
    }, (err) => console.error('観戦の購読に失敗', gameId, err));
    watchUnsubscribers.set(gameId, unsub);
  });

  renderWatchBoards();
}

function renderWatchBoards() {
  const container = el('t-watch-boards');
  container.innerHTML = '';
  [...watchStates.entries()].forEach(([gameId, doc]) => {
    container.appendChild(renderWatchBoard(gameId, doc));
  });
}

/** 1局ぶんの小さな盤面(操作はできない。詳しく見たい人向けにリンクを付ける) */
function renderWatchBoard(gameId, doc) {
  const card = document.createElement('div');
  card.className = 'watch-board';

  const head = document.createElement('div');
  head.className = 'watch-board-head';
  const names = (doc.names || {});
  const turnLabel = doc.state && doc.state.turn === 'sente' ? 'sente' : 'gote';
  ['sente', 'gote'].forEach((owner, i) => {
    if (i === 1) {
      const vs = document.createElement('span');
      vs.className = 'matchup-vs';
      vs.textContent = 'vs';
      head.appendChild(vs);
    }
    const chip = document.createElement('span');
    chip.className = `matchup-player matchup-player--${owner}`;
    if (doc.status === 'playing' && turnLabel === owner) chip.classList.add('matchup-player--turn');
    chip.textContent = (names[owner] || '').trim() || (owner === 'sente' ? '先手' : '後手');
    head.appendChild(chip);
  });
  card.appendChild(head);

  const board = document.createElement('div');
  board.className = 'board watch-board-grid';
  const flat = (doc.state && doc.state.board) || [];
  for (let r = 0; r < GameLogic.BOARD_ROWS; r++) {
    for (let c = 0; c < GameLogic.BOARD_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const piece = flat[r * GameLogic.BOARD_COLS + c];
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = `piece owner-${piece.owner}${piece.owner === 'gote' ? ' piece-rotated' : ''}`;
        pieceEl.textContent = WATCH_PIECE_EMOJI[piece.type] || '';
        cell.appendChild(pieceEl);
      }
      board.appendChild(cell);
    }
  }
  card.appendChild(board);

  const foot = document.createElement('div');
  foot.className = 'watch-board-foot';
  const link = document.createElement('a');
  link.className = 'btn btn--outline btn--sm';
  link.href = `index.html?room=${gameId}`;
  link.textContent = 'この対局を開く';
  foot.appendChild(link);
  card.appendChild(foot);

  return card;
}

const WATCH_PIECE_EMOJI = { lion: '🦁', elephant: '🐘', giraffe: '🦒', chick: '🐤', hen: '🐔' };

function setupEvents() {
  el('create-t-btn').addEventListener('click', createTournament);
  el('delete-t-btn').addEventListener('click', deleteTournament);
  el('watch-mode-toggle').addEventListener('change', () => { if (tDoc) syncWatchMode(tDoc); });
  el('join-t-btn').addEventListener('click', () => joinTournament(el('t-code-input').value.trim(), el('join-name').value.trim()));
  el('t-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('join-t-btn').click(); });
  el('start-t-btn').addEventListener('click', startTournament);
  el('copy-t-link-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(() => {
      el('copy-t-link-btn').textContent = 'コピーしました!';
      setTimeout(() => { el('copy-t-link-btn').textContent = 'リンクをコピー'; }, 1500);
    });
  });
}

setupEvents();
init();
