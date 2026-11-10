/* ============================================================
   金樽牌局 · AI 对手
   叫分评估 / 跟牌策略 / 农民配合 / 领出选择
   ============================================================ */
(function (global) {
  'use strict';

  const C = global.Cards;

  function isFarmer(a, landlord) {
    return a !== landlord;
  }

  /** 两位玩家是否为队友（同为农民） */
  function isTeammate(a, b, landlord) {
    return a !== b && isFarmer(a, landlord) && isFarmer(b, landlord);
  }

  /** 手牌强度评估：王 > 2 > A，炸弹与三张加权 */
  function evaluateHand(hand) {
    const groups = C.groupCounts(hand);
    let score = 0;

    for (const [rank, cards] of groups) {
      const n = cards.length;
      if (rank === 17) score += 4;
      else if (rank === 16) score += 3;
      else if (rank === 15) score += 1.15 * n;
      else if (rank === 14) score += 0.5 * n;

      if (n === 4) score += 4;
      else if (n === 3) score += 0.8;
    }
    if (groups.has(16) && groups.has(17)) score += 2.5;

    // 顺子潜力
    const ranks = Array.from(groups.keys()).filter((r) => r <= 14).sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i < ranks.length; i++) {
      run = ranks[i] === ranks[i - 1] + 1 ? run + 1 : 1;
      if (run >= 5) {
        score += 0.6;
        break;
      }
    }
    return score;
  }

  /** 叫分：返回 0（不叫）或 1/2/3 */
  function decideBid(hand, highestBid) {
    const s = evaluateHand(hand);
    let want = 0;
    if (s >= 8) want = 3;
    else if (s >= 6) want = 2;
    else if (s >= 4.2) want = 1;

    // 偶尔保守
    if (want > 0 && Math.random() < 0.1) want -= 1;
    return want > highestBid ? want : 0;
  }

  function minEnemyCount(ctx) {
    let min = 99;
    for (let i = 0; i < 3; i++) {
      if (i === ctx.self) continue;
      if (!isTeammate(i, ctx.self, ctx.landlord)) min = Math.min(min, ctx.counts[i]);
    }
    return min;
  }

  /** 该出牌是否拆了自己手上的炸弹 */
  function splitsBomb(hand, move) {
    const groups = C.groupCounts(hand);
    const used = new Map();
    for (const c of move.cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);
    for (const [rank, count] of used) {
      if (groups.get(rank).length === 4 && count < 4) return true;
    }
    return false;
  }

  /**
   * 选择出牌。
   * @param {Array} hand 手牌
   * @param {{info:object}|null} lastPlay 需要压过的上一层出牌
   * @param {{self:number,lastPlayer:number,landlord:number,counts:number[]}} ctx
   * @returns {{cards:Array,info:object}|null} null 表示不出
   */
  function choosePlay(hand, lastPlay, ctx) {
    if (!hand.length) return null;
    const lastInfo = lastPlay ? lastPlay.info : null;
    const candidates = C.findBeatingMoves(hand, lastInfo);
    if (!candidates.length) return null;

    // 能一把走完，立刻走
    const finish = candidates.find((m) => m.cards.length === hand.length);
    if (finish) return finish;

    // ---------- 跟牌 ----------
    if (lastPlay) {
      const fromTeammate =
        ctx.lastPlayer !== ctx.self &&
        isTeammate(ctx.lastPlayer, ctx.self, ctx.landlord);
      if (fromTeammate) return null;

      const nonBomb = candidates.filter(
        (m) => m.info.type !== 'bomb' && m.info.type !== 'rocket'
      );

      if (nonBomb.length) {
        const safe = nonBomb.filter((m) => !splitsBomb(hand, m));
        const pool = safe.length ? safe : nonBomb;
        pool.sort((a, b) => C.movePower(a) - C.movePower(b));
        return pool[0];
      }

      // 只剩炸弹 / 王炸
      const bombs = candidates.slice().sort((a, b) => C.movePower(a) - C.movePower(b));
      const enemyClose = minEnemyCount(ctx) <= 2;
      if (enemyClose || hand.length <= 5 || Math.random() < 0.08) {
        return bombs[0];
      }
      return null;
    }

    // ---------- 领出 ----------
    const all = C.generateMoves(hand);
    if (!all.length) return null;
    let pool = all.filter((m) => m.info.type !== 'bomb' && m.info.type !== 'rocket');
    if (!pool.length) pool = all;

    // 下家是敌人且只剩一张牌：尽量不出单张
    const next = (ctx.self + 1) % 3;
    const nextIsEnemy = !isTeammate(next, ctx.self, ctx.landlord);
    if (nextIsEnemy && ctx.counts[next] === 1) {
      const multi = pool.filter((m) => m.cards.length > 1);
      if (multi.length) pool = multi;
    }

    let best = null;
    let bestScore = Infinity;
    for (const m of pool) {
      const type = m.info.type;
      let score = m.info.rank - m.cards.length * 2.1;

      // 大牌留着控场
      if (m.info.rank >= 15) score += 7;
      // 早出三带
      if (type === 'triple1' || type === 'triple2') score -= 1.4;
      // 别拆炸弹
      if (splitsBomb(hand, m)) score += 4;

      score += Math.random() * 1.4;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
  }

  /** 出牌耗时（毫秒），大牌/炸弹思考更久 */
  function thinkTime(move) {
    let base = 650 + Math.random() * 650;
    if (move) {
      if (move.info.type === 'bomb' || move.info.type === 'rocket') base += 500;
      else if (move.cards.length >= 5) base += 200;
    } else {
      base += 150;
    }
    return base;
  }

  global.AI = {
    evaluateHand,
    decideBid,
    choosePlay,
    thinkTime,
    isTeammate
  };
})(window);
