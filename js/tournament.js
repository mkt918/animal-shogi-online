// 大会モード: 大会の作成/参加、組み合わせ生成、対局の開始、順位表の表示

let db, uid = null;
let tCode = null;
let tDoc = null;
let unsubscribeT = null;

const el = (id) => document.getElementById(id);
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
          status: 'waiting',
          tournamentId: tCode,
          matchId: match.id,
          expectedGote: opponent,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
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
  if (m.winner) {
    const isBye = tDoc.format === 'knockout' && m.round === 1 && (!m.p1 || !m.p2);
    action.appendChild(makeTag(
      m.winner === 'draw' ? '引き分け' : isBye ? '不戦勝で進出' : `${nameOf(m.winner)}の勝ち`,
      'tag--done',
    ));
  } else if (!bothDecided) {
    action.appendChild(makeTag('未定'));
  } else if (m.gameId) {
    const a = document.createElement('a');
    a.className = 'btn btn--sm ' + (mine ? 'btn--cyan' : 'btn--outline');
    a.href = `index.html?room=${m.gameId}`;
    a.textContent = mine ? '対局に参加' : '観戦';
    action.appendChild(a);
    action.appendChild(makeTag('対局中'));
  } else if (mine && tDoc.status === 'running') {
    const b = document.createElement('button');
    b.className = 'btn btn--sm btn--pear';
    b.textContent = '対局を始める';
    b.addEventListener('click', () => startMatch(m));
    action.appendChild(b);
  } else {
    action.appendChild(makeTag('未対局'));
  }
  row.appendChild(action);
  return row;
}

function setupEvents() {
  el('create-t-btn').addEventListener('click', createTournament);
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
