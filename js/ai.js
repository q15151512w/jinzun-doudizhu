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
    // 花牌（万能牌）可补任意牌型
    score += hand.filter((c) => c.wild).length * 2.8;

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

  /** 花牌是否能补齐炸弹：有三张同点 + 花牌时返回该点数，否则 -1 */
  function wildBombRank(hand) {
    if (!hand.some((c) => c.wild)) return -1;
    for (const [rank, cards] of C.groupCounts(hand)) {
      if (rank <= 15 && cards.length === 3) return rank;
    }
    return -1;
  }

  const ATTACH_TYPES = ['triple1', 'triple2', 'plane1', 'plane2', 'four2', 'four2p'];

  /** 用大牌（K / A / 2 / 王）当带牌的代价 */
  function attachmentPenalty(move) {
    if (!ATTACH_TYPES.includes(move.info.type)) return 0;
    const counts = new Map();
    for (const c of move.cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
    let penalty = 0;
    for (const [rank, n] of counts) {
      if (n >= 3) continue; // 主牌（三张 / 四张 / 飞机主体）
      if (rank >= 16) penalty += 24;
      else if (rank === 15) penalty += 18;
      else if (rank === 14) penalty += 12;
      else if (rank === 13) penalty += 4;
    }
    return penalty;
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

  /* ------------------------- 手牌拆解 ------------------------- */

  /**
   * 把手牌规划成若干组，用于「领出不含大牌」与「不拆散结构」。
   * 炸弹 / 王炸单独保留，其余依次抽取飞机、连对、顺子、三张、对子、单张。
   * @returns {Array<{kind:string,cards:Array}>}
   */
  function decompose(hand) {
    const pool = new Map();
    for (const c of C.sortCards(hand)) {
      if (!pool.has(c.rank)) pool.set(c.rank, []);
      pool.get(c.rank).push(c);
    }
    const count = (r) => (pool.get(r) || []).length;
    const take = (r, k) => {
      const arr = pool.get(r);
      const out = arr.splice(0, k);
      if (!arr.length) pool.delete(r);
      return out;
    };

    const plan = [];

    if (count(16) && count(17)) {
      plan.push({ kind: 'rocket', cards: take(16, 1).concat(take(17, 1)) });
    }

    // 炸弹不拆进顺子
    for (const r of Array.from(pool.keys())) {
      if (count(r) === 4) plan.push({ kind: 'bomb', cards: take(r, 4) });
    }

    // 先拿需要张数多的连牌，避免把对子 / 三张拆碎
    const RUNS = [
      { need: 3, min: 2 },
      { need: 2, min: 3 },
      { need: 1, min: 5 }
    ];
    for (const { need, min } of RUNS) {
      let changed = true;
      while (changed) {
        changed = false;
        let r = 3;
        while (r <= 14) {
          if (count(r) < need) { r++; continue; }
          let end = r;
          while (end + 1 <= 14 && count(end + 1) >= need) end++;
          if (end - r + 1 >= min) {
            const cards = [];
            for (let x = r; x <= end; x++) cards.push(...take(x, need));
            plan.push({ kind: 'chain', cards });
            changed = true;
          }
          r = end + 1;
        }
      }
    }

    // 剩余三张 / 对子 / 单张
    for (const r of Array.from(pool.keys()).sort((a, b) => a - b)) {
      const n = count(r);
      if (n >= 3) plan.push({ kind: 'triple', cards: take(r, 3) });
      else if (n === 2) plan.push({ kind: 'pair', cards: take(r, 2) });
      else plan.push({ kind: 'single', cards: take(r, 1) });
    }
    return plan;
  }

  /** 单张牌的「代价」：2 与王很贵，避免当普通牌打掉 */
  function cardWeight(card) {
    const r = card.rank;
    if (r >= 16) return 30;
    if (r === 15) return 22;
    if (r === 14) return 16;
    return r;
  }

  function moveCost(move) {
    let sum = 0;
    for (const c of move.cards) sum += cardWeight(c);
    return sum;
  }

  const DECK_COUNTS = (() => {
    const m = new Map();
    for (let r = 3; r <= 15; r++) m.set(r, 4);
    m.set(16, 1);
    m.set(17, 1);
    m.set(18, 1); // 花牌
    return m;
  })();

  /** 场上还未露面的牌（去掉自己的手牌和已出的牌） */
  function unseenCounts(hand, played) {
    const m = new Map(DECK_COUNTS);
    const drop = (c) => m.set(c.rank, (m.get(c.rank) || 0) - 1);
    for (const c of hand) drop(c);
    if (played) for (const c of played) drop(c);
    return m;
  }

  /** 这手牌是否已经没人能压住（只精确判断单张 / 对子 / 炸弹） */
  function isUnbeatable(move, unseen) {
    const type = move.info.type;
    const rank = move.info.rank;
    const wild = unseen.get(18) > 0;
    if (type === 'rocket') return true;
    if (type === 'bomb') {
      for (const [r, n] of unseen) {
        if (r > rank && (n >= 4 || (wild && n >= 3))) return false;
      }
      return !(unseen.get(16) > 0 && unseen.get(17) > 0);
    }
    if (type === 'single' || type === 'pair') {
      // 炸弹 / 王炸随时可能压下
      for (const [r, n] of unseen) {
        if (n >= 4) return false;
      }
      if (unseen.get(16) > 0 && unseen.get(17) > 0) return false;
      // 花牌可以补成任意单张 / 对子（点数不超过 2）
      if (wild && rank < 15) return false;
      const need = type === 'pair' ? 2 : 1;
      for (const [r, n] of unseen) {
        if (r > rank && n >= need) return false;
      }
      return true;
    }
    return false;
  }

  /** 这手牌拆散了多少既定结构（对子 / 三张 / 连牌） */
  function structurePenalty(plan, move) {
    const ids = new Set(move.cards.map((c) => c.id));
    let penalty = 0;
    for (const g of plan) {
      if (g.cards.length < 2 || g.kind === 'bomb' || g.kind === 'rocket') continue;
      let used = 0;
      for (const c of g.cards) if (ids.has(c.id)) used++;
      if (used > 0 && used < g.cards.length) {
        penalty += g.cards.length >= 3 ? 2.4 : 1.5;
      }
    }
    return penalty;
  }

  function groupCount(plan) {
    return plan.filter((g) => g.kind !== 'bomb' && g.kind !== 'rocket').length;
  }

  /** 从拆解结果构造领出候选：三张尽量带低牌，绝不用大牌当带牌 */
  function leadOptions(plan) {
    const singles = plan.filter((g) => g.kind === 'single');
    const pairs = plan.filter((g) => g.kind === 'pair');
    const options = [];
    const add = (cards) => {
      const info = C.analyze(cards);
      if (!info || info.type === 'bomb' || info.type === 'rocket') return;
      options.push({ cards: C.sortCards(cards), info });
    };

    for (const g of plan) {
      if (g.kind === 'bomb' || g.kind === 'rocket') continue;
      if (g.kind === 'triple') {
        // 带牌只用 10 以下的小牌
        const kicker = singles.find((x) => x.cards[0].rank <= 10) ||
          pairs.find((x) => x.cards[0].rank <= 10);
        if (kicker) add(g.cards.concat(kicker.cards));
        add(g.cards.slice());
      } else if (g.kind === 'chain') {
        add(g.cards.slice());
        // 飞机尽量带上小牌，一次多走几张，少出单张
        const info = C.analyze(g.cards);
        if (info && info.type === 'plane') {
          const len = info.seq;
          const lowSingles = [];
          for (const s of singles) {
            if (s.cards[0].rank <= 10) lowSingles.push(...s.cards);
          }
          if (lowSingles.length >= len) {
            add(g.cards.concat(lowSingles.slice(0, len)));
          }
          const lowPairs = [];
          for (const p of pairs) {
            if (p.cards[0].rank <= 10) lowPairs.push(...p.cards);
          }
          if (lowPairs.length >= 2 * len) {
            add(g.cards.concat(lowPairs.slice(0, 2 * len)));
          }
        }
      } else {
        add(g.cards.slice());
      }
    }
    return options;
  }

  /** 领出牌的优先级：点数越低越先出，多张组合优先，单张适当押后 */
  function leadValue(move) {
    let value = move.info.rank - move.cards.length * 1.8;
    if (move.info.type === 'single') value += 6.0;
    return value + Math.random() * 1.0;
  }

  /** 跟牌时挑代价最小的一手：低牌优先、不拆结构、少动 A / 2 / 王 */
  function pickCheapest(plan, pool, enemyMin) {
    let best = null;
    let bestScore = Infinity;
    for (const m of pool) {
      let score = moveCost(m);
      score += structurePenalty(plan, m) * 4;
      score += attachmentPenalty(m);
      // 敌人不紧张时，A / 2 / 王 留作控场
      if (enemyMin > 3 && m.info.rank >= 14) score += 10;
      score += Math.random() * 0.9;
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best;
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

    const plan = decompose(hand);
    const unseen = unseenCounts(hand, ctx.played);
    const next = (ctx.self + 1) % 3;
    const nextIsEnemy = !isTeammate(next, ctx.self, ctx.landlord);
    const nextCount = ctx.counts[next];
    const enemyMin = minEnemyCount(ctx);
    const danger = enemyMin <= 2;
    const bombRank = wildBombRank(hand);
    const bombReady = bombRank >= 0;
    const pressing = danger || hand.length <= 6;

    // ---------- 跟牌 ----------
    if (lastPlay) {
      const fromTeammate =
        ctx.lastPlayer !== ctx.self &&
        isTeammate(ctx.lastPlayer, ctx.self, ctx.landlord);

      const nonBomb = candidates.filter(
        (m) => m.info.type !== 'bomb' && m.info.type !== 'rocket'
      );
      const keepBomb = nonBomb.filter((m) => !usesPartialBomb(hand, m));
      const pool = keepBomb.length ? keepBomb : nonBomb;

      if (fromTeammate) {
        // 队友出牌：默认让牌，但自己更有把握时接管，避免「一手都不出」
        if (!pool.length) return null;

        // 留着花牌凑炸弹、也不用大牌当带牌
        let teamPool = pool;
        if (bombReady) {
          const keep = teamPool.filter(
            (m) => !m.cards.some((c) => c.wild || c.rank === bombRank)
          );
          if (keep.length) teamPool = keep;
          else return null;
        }
        const cleanPool = teamPool.filter((m) => attachmentPenalty(m) === 0);
        if (cleanPool.length) teamPool = cleanPool;
        else return null;

        // 1) 出完这手只剩两手牌：接管，争取自己先走完
        let bestLeft = Infinity;
        for (const m of teamPool) {
          const left = groupCount(decompose(C.removeCards(hand, m.cards)));
          if (left < bestLeft) bestLeft = left;
        }
        if (bestLeft <= 2) {
          const winners = teamPool.filter(
            (m) => groupCount(decompose(C.removeCards(hand, m.cards))) === bestLeft
          );
          return pickCheapest(plan, winners, enemyMin);
        }

        const cheap = pickCheapest(plan, teamPool, enemyMin);
        if (!cheap) return null;
        const clean = structurePenalty(plan, cheap) === 0;
        const myCount = hand.length;
        const mateCount = ctx.counts[ctx.lastPlayer];

        // 2) 自己明显比队友更接近走完（少 3 张以上）：接管节奏
        if (clean && myCount + 3 <= mateCount) return cheap;

        // 3) 队友只出了小牌、自己接得动且代价不高：经常抢一次节奏
        if (clean && lastInfo.rank <= 10 && cheap.info.rank <= 12 && Math.random() < 0.65) {
          return cheap;
        }
        return null;
      }

      if (pool.length) {
        let usable = pool;
        // 手里能凑炸弹：花牌和三张都留着，不拆不花
        if (bombReady) {
          const keep = usable.filter(
            (m) => !m.cards.some((c) => c.wild || c.rank === bombRank)
          );
          if (keep.length) usable = keep;
          else if (!pressing) return null;
        }
        // 不为跟一手而拿 K / A / 2 / 王 当带牌
        const cleanPool = usable.filter((m) => attachmentPenalty(m) === 0);
        if (cleanPool.length) usable = cleanPool;
        else if (!pressing) return null;

        // 下家只剩一两张牌：用最大的牌封堵，别让他接手
        if (danger && nextIsEnemy && nextCount <= 2) {
          const sorted = usable.slice().sort((a, b) => C.movePower(b) - C.movePower(a));
          return sorted[0];
        }
        return pickCheapest(plan, usable, enemyMin);
      }

      // 只剩炸弹 / 王炸：阻断对手、快走完、或炸完下一手能走完时才用
      const bombs = candidates.slice().sort((a, b) => C.movePower(a) - C.movePower(b));
      const afterGroups = groupCount(decompose(C.removeCards(hand, bombs[0].cards)));
      if (danger || hand.length <= 6 || afterGroups <= 1 || Math.random() < 0.1) {
        return bombs[0];
      }
      return null;
    }

    // ---------- 领出 ----------
    let pool = leadOptions(plan);
    if (hand.some((c) => c.wild) && !bombReady) {
      // 花牌可以补顺子 / 对子 / 三张等，加入这些含花候选
      const wildMoves = candidates.filter(
        (m) => m.cards.some((c) => c.wild) &&
          m.info.type !== 'bomb' && m.info.type !== 'rocket' &&
          attachmentPenalty(m) === 0
      );
      pool = pool.concat(wildMoves);
    }
    if (bombReady) {
      // 花牌 + 三张留着凑炸弹，不拆散、不当普通牌打出去
      const keep = pool.filter(
        (m) => !m.cards.some((c) => c.wild || c.rank === bombRank)
      );
      if (keep.length) pool = keep;
    }
    if (!pool.length) {
      // 手上只剩炸弹 / 王炸
      pool = C.generateMoves(hand);
    }

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

    // 残局：只剩两手牌——先出炸弹，或先出「已经没人压得住」的一手，锁定胜局
    if (plan.length === 2) {
      const reserved = plan.find((g) => g.kind === 'bomb' || g.kind === 'rocket');
      if (reserved) {
        const info = C.analyze(reserved.cards);
        if (info) return { cards: C.sortCards(reserved.cards), info };
      }
      const safe = pool.find((m) => isUnbeatable(m, unseen));
      if (safe) return safe;
    }

    let best = null;
    let bestValue = Infinity;
    for (const m of pool) {
      if (m.info.type === 'four2' || m.info.type === 'four2p') continue;
      const v = leadValue(m);
      if (v < bestValue) {
        bestValue = v;
        best = m;
      }
    }
    return best || pool[0] || null;
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
    isTeammate,
    decompose
  };
})(window);
