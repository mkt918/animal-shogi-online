/**
 * 大会(リーグ戦/トーナメント)の純粋ロジック。Firebase非依存。
 *
 * match: { id, round, p1, p2, gameId, winner }
 *   p1/p2  : 参加者uid。null は「休み(不戦)」
 *   winner : null(未対局) | uid | 'draw'
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

const TournamentLogic = { generateRoundRobin, computeStandings };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TournamentLogic;
} else {
  window.TournamentLogic = TournamentLogic;
}
