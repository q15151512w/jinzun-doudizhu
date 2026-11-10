/* ============================================================
   金樽牌局 · AI 对手
   叫地主 / 抢地主评估 / 跟牌策略 / 农民配合 / 领出选择
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

  /** 兼容旧的自对弈测试：返回 0/1/2/3 */
  function decideBid(hand, highestBid) {
    const s = evaluateHand(hand);
    let want = 0;
    if (s >= 8) want = 3;
    else if (s >= 6) want = 2;
    else if (s >= 4.2) want = 1;
    if (want > 0 && Math.random() < 0.1) want -= 1;
    return want > highestBid ? want : 0;
  }

  /** 叫地主：只有一次机会，牌好就叫 */
  function decideCall(hand, lastChance) {
    const s = evaluateHand(hand);
    const threshold = lastChance ? 3.2 : 4.3;
    if (s >= threshold + 0.8) return true;
    if (s >= threshold) return Math.random() < 0.6;
    return false;
  }

  /** 抢地主：抢的人越多，门槛越高 */
  function decideRob(hand, robCount) {
    const s = evaluateHand(hand);
    const threshold = 5.2 + robCount * 1.4;
    return s >= threshold - Math.random() * 0.7;
  }

  /** 是否从四张相同的牌里抽了一部分（拆炸弹） */
  function usesPartialBomb(hand, move) {
    const groups = C.groupCounts(hand);
    const used = new Map();
    for (const c of move.cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);
    for (const [rank, count] of used) {
      if (groups.get(rank).length === 4 && count < 4) return true;
    }
    return false;
  }

  /** 拆散对子 / 三张 / 炸弹的代价 */
  function splitPenalty(hand, move) {
    const groups = C.groupCounts(hand);
    const used = new Map();
    for (const c of move.cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);

    let penalty = 0;
    for (const [rank, count] of used) {
      const total = groups.get(rank).length;
      if (count >= total) continue;
      if (total === 4) penalty += 5;
      else if (total === 3) penalty += 2;
      else if (total === 2) penalty += 1;
    }
    return penalty;
  }

  function minEnemyCount(ctx) {
    let min = 99;
    for (let i = 0; i < 3; i++) {
      if (i === ctx.self) continue;
      if (!isTeammate(i, ctx.self, ctx.landlord)) min = Math.min(min, ctx.counts[i]);
    }
    return min;
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

    const next = (ctx.self + 1) % 3;
    const nextIsEnemy = !isTeammate(next, ctx.self, ctx.landlord);
    const nextCount = ctx.counts[next];

    // ---------- 跟牌 ----------
    if (lastPlay) {
      const fromTeammate =
        ctx.lastPlayer !== ctx.self &&
        isTeammate(ctx.lastPlayer, ctx.self, ctx.landlord);

      if (fromTeammate) {
        // 队友出小单张、下家地主只剩 1 张：用大单张顶住
        if (
          nextIsEnemy &&
          nextCount === 1 &&
          lastInfo.type === 'single' &&
          lastInfo.rank < 15
        ) {
          const singles = candidates.filter((m) => m.info.type === 'single');
          if (singles.length) {
            singles.sort((a, b) => b.info.rank - a.info.rank);
            return singles[0];
          }
        }
        return null;
      }

      const nonBomb = candidates.filter(
        (m) => m.info.type !== 'bomb' && m.info.type !== 'rocket'
      );
      const enemyMin = minEnemyCount(ctx);

      if (nonBomb.length) {
        const keepBomb = nonBomb.filter((m) => !usesPartialBomb(hand, m));
        const pool = keepBomb.length ? keepBomb : nonBomb;
        const scored = pool.map((m) => {
          let score = C.movePower(m);
          // 尽量不拆对子 / 三张 / 炸弹
          score += splitPenalty(hand, m) * 1.8;
          // 不轻易把 2 和王当普通牌打出去
          if (m.info.rank >= 15 && enemyMin > 3) score += 1.6;
          return { m, score };
        }).sort((a, b) => a.score - b.score);
        return scored[0].m;
      }

      // 只剩炸弹 / 王炸
      const bombs = candidates.slice().sort((a, b) => C.movePower(a) - C.movePower(b));
      const enemyClose = enemyMin <= 2;
      if (enemyClose || hand.length <= 6 || Math.random() < 0.1) {
        return bombs[0];
      }
      return null;
    }

    // ---------- 领出 ----------
    const all = C.generateMoves(hand);
    if (!all.length) return null;

    // 炸弹留作关键回合；不主动拆炸弹、不用四带二白白消耗炸弹
    let pool = all.filter(
      (m) =>
        !['bomb', 'rocket', 'four2', 'four2p'].includes(m.info.type) &&
        !usesPartialBomb(hand, m)
    );
    if (!pool.length) {
      pool = all.filter((m) => m.info.type !== 'bomb' && m.info.type !== 'rocket');
    }
    if (!pool.length) pool = all;

    // 下家是敌人且只剩一张牌：避免送单张；只剩单张时出最大的
    if (nextIsEnemy && nextCount === 1) {
      const multi = pool.filter((m) => m.cards.length > 1);
      if (multi.length) {
        pool = multi;
      } else {
        const singles = pool.filter((m) => m.info.type === 'single');
        if (singles.length) {
          singles.sort((a, b) => b.info.rank - a.info.rank);
          return singles[0];
        }
      }
    }

    const enemies = [0, 1, 2].filter(
      (i) => i !== ctx.self && !isTeammate(i, ctx.self, ctx.landlord)
    );

    let best = null;
    let bestScore = Infinity;
    for (const m of pool) {
      const type = m.info.type;
      let score = m.info.rank - m.cards.length * 2.1;

      // 拆牌代价
      score += splitPenalty(hand, m) * 1.2;
      // 大牌留着控场
      if (m.info.rank >= 15) score += 6;
      // 早出三带
      if (type === 'triple1' || type === 'triple2') score -= 1.4;
      // 别把炸弹拆成「四带二」随手打掉
      if (type === 'four2' || type === 'four2p') score += 4;

      // 对手剩余牌数正好等于本次出牌张数：别送对手走完
      for (const e of enemies) {
        const c = ctx.counts[e];
        if (c > 0 && c === m.cards.length) score += 2.5;
      }

      score += Math.random() * 1.0;
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
    decideCall,
    decideRob,
    choosePlay,
    thinkTime,
    isTeammate
  };
})(window);
