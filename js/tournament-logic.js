/**
 * 大会(リーグ戦/トーナメント)の純粋ロジック。Firebase非依存。
 *
 * リーグ戦の match: { id, round, p1, p2, gameId, winner }
 *   p1/p2  : 参加者uid。null は「休み(不戦)」
 *   winner : null(未対局) | uid | 'draw'
 *
 * トーナメント(ノックアウト)の match: { id, round, p1, p2, gameId, winner, nextMatchId, nextSlot }
 *   p1/p2       : 参加者uid。null は「まだ決まっていない(前の対局待ち)」、
 *                 または生成直後のみ「不戦勝(バイ)」を意味する
 *   nextMatchId : 勝者が進む次の対局のid。決勝は null
 *   nextSlot    : 次の対局の 'p1' | 'p2' のどちらに入るか
 */

/**
 * 総当たり(リーグ戦)の組み合わせを生成する。サークル法。
 * 奇数人数のときは仮想の「休み」を1人足し、その相手は休みになる。
 */
function generateRoundRobin(uids) {
  const list = [...uids];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = n - 1;
  const matches = [];
  let id = 1;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === null || b === null) continue; // 休み
      // 先手/後手の偏りを減らすため、ラウンドごとに入れ替える
      const [p1, p2] = (r + i) % 2 === 0 ? [a, b] : [b, a];
      matches.push({ id: `m${id++}`, round: r + 1, p1, p2, gameId: null, winner: null });
    }
    // 先頭を固定して残りを回転
    list.splice(1, 0, list.pop());
  }
  return matches;
}

/**
 * 順位表を計算する。勝ち=3点、引き分け=1点、負け=0点。
 * 並び順: 勝ち点 → 勝ち数 → 直接対決(2人の場合のみ) → 名前
 */
function computeStandings(players, matches) {
  const rows = new Map();
  players.forEach((p) => rows.set(p.uid, { uid: p.uid, name: p.name, played: 0, win: 0, draw: 0, loss: 0, points: 0 }));

  matches.forEach((m) => {
    if (!m.winner || !m.p1 || !m.p2) return;
    const a = rows.get(m.p1);
    const b = rows.get(m.p2);
    if (!a || !b) return;
    a.played += 1;
    b.played += 1;
    if (m.winner === 'draw') {
      a.draw += 1; b.draw += 1; a.points += 1; b.points += 1;
    } else if (m.winner === m.p1) {
      a.win += 1; b.loss += 1; a.points += 3;
    } else {
      b.win += 1; a.loss += 1; b.points += 3;
    }
  });

  const headToHead = (x, y) => {
    const m = matches.find((mm) => mm.winner && mm.winner !== 'draw'
      && ((mm.p1 === x.uid && mm.p2 === y.uid) || (mm.p1 === y.uid && mm.p2 === x.uid)));
    if (!m) return 0;
    return m.winner === x.uid ? -1 : 1;
  };

  const sorted = [...rows.values()].sort((x, y) =>
    y.points - x.points || y.win - x.win || headToHead(x, y) || x.name.localeCompare(y.name, 'ja'));
  let rank = 0;
  let prev = null;
  sorted.forEach((row, i) => {
    if (!prev || prev.points !== row.points || prev.win !== row.win) rank = i + 1;
    row.rank = rank;
    prev = row;
  });
  return sorted;
}

/**
 * 標準的なトーナメント表のシード順を返す(1-indexed)。
 * 例: size=8 → [1,8,4,5,2,7,3,6]。1位と2位のシードは決勝まで当たらない。
 */
function seedOrder(size) {
  if (size === 1) return [1];
  const prev = seedOrder(size / 2);
  const result = [];
  prev.forEach((s) => {
    result.push(s, size + 1 - s);
  });
  return result;
}

/**
 * トーナメント(ノックアウト)の組み合わせを生成する。
 * 人数が2の累乗でない場合は、次の2の累乗の枠まで「不戦勝(バイ)」で埋める。
 * 不戦勝は標準シード順で上位シードに割り当てられ、生成した時点で自動的に勝ち抜け処理される。
 */
function generateKnockout(uids) {
  const n = uids.length;
  if (n < 2) throw new Error('2人以上必要です');

  const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
  const seeds = seedOrder(bracketSize);
  const slots = seeds.map((seedNum) => (seedNum <= n ? uids[seedNum - 1] : null));
  const totalRounds = Math.log2(bracketSize);

  const matches = [];
  let idCounter = 1;

  let prevRoundMatches = [];
  for (let i = 0; i < bracketSize / 2; i++) {
    const m = {
      id: `m${idCounter++}`, round: 1,
      p1: slots[i * 2], p2: slots[i * 2 + 1],
      gameId: null, winner: null, nextMatchId: null, nextSlot: null,
    };
    prevRoundMatches.push(m);
  }
  matches.push(...prevRoundMatches);

  for (let r = 2; r <= totalRounds; r++) {
    const roundMatches = [];
    for (let i = 0; i < prevRoundMatches.length / 2; i++) {
      const m = { id: `m${idCounter++}`, round: r, p1: null, p2: null, gameId: null, winner: null, nextMatchId: null, nextSlot: null };
      roundMatches.push(m);
      prevRoundMatches[i * 2].nextMatchId = m.id;
      prevRoundMatches[i * 2].nextSlot = 'p1';
      prevRoundMatches[i * 2 + 1].nextMatchId = m.id;
      prevRoundMatches[i * 2 + 1].nextSlot = 'p2';
    }
    matches.push(...roundMatches);
    prevRoundMatches = roundMatches;
  }

  resolveByes(matches);
  return matches;
}

/**
 * 「片方だけ不在(不戦勝)」の対局を自動的に勝ち抜けさせ、次の対局へ進出させる。
 *
 * 不戦勝が起こりうるのは1回戦(シードで直接 null が割り当てられた枠)だけ。
 * 2回戦以降の枠が null なのは「まだ前の対局の結果待ち」という意味でしかないので、
 * ここで自動的に勝ち抜け扱いにしてはいけない(片方が確定済みでも、もう片方の対局が
 * 終わるまでは待つのが正しい)。そのため round === 1 の対局だけを対象にする。
 */
function resolveByes(matches) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  for (const m of matches) {
    if (m.round !== 1 || m.winner) continue;
    const hasP1 = m.p1 !== null;
    const hasP2 = m.p2 !== null;
    if (hasP1 && !hasP2) {
      advanceWinner(byId, m, m.p1);
    } else if (hasP2 && !hasP1) {
      advanceWinner(byId, m, m.p2);
    }
  }
}

function advanceWinner(byId, match, winnerUid) {
  match.winner = winnerUid;
  if (match.nextMatchId) {
    const next = byId.get(match.nextMatchId);
    if (next) next[match.nextSlot] = winnerUid;
  }
}

/**
 * 対局結果を大会の matches に反映する。リーグ戦/トーナメント両対応の単一エントリポイント。
 * 新しい matches 配列と、大会が終了したかどうかを返す(引き分けは進出させず、再戦待ちにする)。
 */
function reportResult(matches, matchId, winnerUid, format) {
  const next = matches.map((m) => ({ ...m }));
  const byId = new Map(next.map((m) => [m.id, m]));
  const m = byId.get(matchId);
  if (!m || m.winner) return { matches: next, finished: isFinished(next, format) };

  if (winnerUid === 'draw') {
    if (format === 'knockout') {
      // ノックアウトは引き分けのままだと進出者が決まらないため、同じ対局をやり直す
      m.gameId = null;
    } else {
      m.winner = 'draw';
    }
    return { matches: next, finished: isFinished(next, format) };
  }

  if (format === 'knockout') {
    advanceWinner(byId, m, winnerUid);
  } else {
    m.winner = winnerUid;
  }

  return { matches: next, finished: isFinished(next, format) };
}

function isFinished(matches, format) {
  if (format === 'knockout') {
    const final = matches.find((m) => !m.nextMatchId);
    return !!(final && final.winner);
  }
  return matches.length > 0 && matches.every((m) => m.winner);
}

/** ブラケット表示用に、対局をラウンドごとへグルーピングする */
function groupByRound(matches) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  return rounds.map((round) => ({ round, matches: matches.filter((m) => m.round === round) }));
}

/** ラウンド番号を「準決勝」「決勝」のような日本語ラベルに変換する(トーナメント用) */
function knockoutRoundLabel(round, totalRounds) {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return '決勝';
  if (fromEnd === 1) return '準決勝';
  if (fromEnd === 2) return '準々決勝';
  return `第${round}回戦`;
}

const TournamentLogic = {
  generateRoundRobin,
  computeStandings,
  generateKnockout,
  reportResult,
  isFinished,
  groupByRound,
  knockoutRoundLabel,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TournamentLogic;
} else {
  window.TournamentLogic = TournamentLogic;
}
