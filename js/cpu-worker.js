// CPUの思考を別スレッドで行う Web Worker。
// 深い探索(最強=8手読み)でもメインスレッド(画面)が固まらないようにする。
importScripts('game-logic.js', 'cpu-ai.js');

self.onmessage = (event) => {
  const { requestId, state, tierId, moveHistory } = event.data;
  let move = null;
  let error = null;
  try {
    move = CpuAI.chooseMove(GameLogic, state, tierId, moveHistory);
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  self.postMessage({ requestId, move, error });
};
