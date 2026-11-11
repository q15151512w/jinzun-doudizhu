/* ============================================================
   金樽牌局 · 牌型引擎
   54 张牌 / 全部牌型识别 / 比较 / 候选出牌生成
   ============================================================ */
(function (global) {
  'use strict';

  const SUITS = [
    { s: '♠', red: false, order: 0 },
    { s: '♥', red: true, order: 1 },
    { s: '♣', red: false, order: 2 },
    { s: '♦', red: true, order: 3 }
  ];

  const LABELS = {
    3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王', 18: '花'
  };

  const TYPE_NAMES = {
    single: '单张', pair: '对子', triple: '三张',
    triple1: '三带一', triple2: '三带二',
    straight: '顺子', pairchain: '连对',
    plane: '飞机', plane1: '飞机带单', plane2: '飞机带对',
    four2: '四带二', four2p: '四带两对',
    bomb: '炸弹', rocket: '王炸'
  };

  function createDeck() {
    const deck = [];
    let id = 0;
    for (let rank = 3; rank <= 15; rank++) {
      for (const suit of SUITS) {
        deck.push({
          id: id++,
          rank,
          label: LABELS[rank],
          suit: suit.s,
          red: suit.red,
          order: suit.order,
          joker: false
        });
      }
    }
    deck.push({ id: id++, rank: 16, label: '小王', suit: '★', red: false, order: 0, joker: true });
    deck.push({ id: id++, rank: 17, label: '大王', suit: '★', red: true, order: 0, joker: true });
    // 花牌：万能牌，可代替 3~2 的任意点数；与双王一起可组成王炸
    deck.push({ id: id++, rank: 18, label: '花', suit: '✿', red: true, order: 0, joker: false, wild: true });
    return deck;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function sortCards(cards) {
    return cards.slice().sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
  }

  /** 手牌展示顺序：大 → 小（同点数按 ♠♥♣♦） */
  function sortCardsDesc(cards) {
    return cards.slice().sort((a, b) => (b.rank - a.rank) || (a.order - b.order));
  }

  function groupCounts(cards) {
    const groups = new Map();
    for (const c of cards) {
      if (!groups.has(c.rank)) groups.set(c.rank, []);
      groups.get(c.rank).push(c);
    }
    return groups;
  }

  function isConsecutive(ranks) {
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] !== ranks[i - 1] + 1) return false;
    }
    return true;
  }

  function info(type, rank, length, seq) {
    return { type, name: TYPE_NAMES[type], rank, length, seq: seq || 0 };
  }

  const WING_ORDER = { plane: 0, plane1: 1, plane2: 2 };

  /**
   * 识别不含花牌的一组牌。
   * @returns {{type:string,name:string,rank:number,length:number,seq:number}|null}
   */
  function analyzePlain(input) {
    if (!input || input.length === 0) return null;
    const cards = sortCards(input);
    const n = cards.length;
    const groups = groupCounts(cards);
    const ranks = Array.from(groups.keys()).sort((a, b) => a - b);
    const rankCount = ranks.length;
    const cnt = (r) => groups.get(r).length;

    // 王炸
    if (n === 2 && groups.has(16) && groups.has(17)) {
      return info('rocket', 17, 2, 0);
    }
    // 炸弹
    if (n === 4 && rankCount === 1) {
      return info('bomb', ranks[0], 4, 0);
    }
    if (n === 1) return info('single', ranks[0], 1, 1);
    if (n === 2 && rankCount === 1) return info('pair', ranks[0], 2, 1);
    if (n === 3 && rankCount === 1) return info('triple', ranks[0], 3, 1);

    if (n === 4 && rankCount === 2) {
      const t = ranks.find((r) => cnt(r) === 3);
      if (t !== undefined) return info('triple1', t, 4, 1);
    }

    if (n === 5) {
      const t = ranks.find((r) => cnt(r) === 3);
      if (t !== undefined) {
        const p = ranks.find((r) => r !== t && cnt(r) === 2);
        if (p !== undefined) return info('triple2', t, 5, 1);
      }
    }

    // 顺子（3 至 A）
    if (n >= 5 && rankCount === n && ranks[rankCount - 1] <= 14 && isConsecutive(ranks)) {
      return info('straight', ranks[rankCount - 1], n, n);
    }

    // 连对
    if (
      n >= 6 && n % 2 === 0 && rankCount === n / 2 && rankCount >= 3 &&
      ranks[rankCount - 1] <= 14 && ranks.every((r) => cnt(r) === 2) &&
      isConsecutive(ranks)
    ) {
      return info('pairchain', ranks[rankCount - 1], n, rankCount);
    }

    // 四带二 / 四带两对
    for (const q of ranks) {
      if (cnt(q) !== 4) continue;
      const rest = n - 4;
      if (rest === 2) return info('four2', q, 6, 1);
      if (rest === 4) {
        const others = ranks.filter((r) => r !== q);
        if (others.length === 2 && others.every((r) => cnt(r) === 2)) {
          return info('four2p', q, 8, 1);
        }
      }
    }

    // 飞机（含带单 / 带对）
    const triples = ranks.filter((r) => r <= 14 && cnt(r) >= 3);
    let best = null;
    for (let i = 0; i < triples.length; i++) {
      for (let len = triples.length - i; len >= 2; len--) {
        const run = triples.slice(i, i + len);
        if (!isConsecutive(run)) continue;

        const rem = new Map();
        for (const r of ranks) rem.set(r, cnt(r));
        for (const r of run) rem.set(r, rem.get(r) - 3);

        let remTotal = 0;
        const remEntries = [];
        for (const [r, v] of rem) {
          if (v > 0) {
            remTotal += v;
            remEntries.push([r, v]);
          }
        }
        if (remTotal !== n - 3 * len) continue;

        const runSet = new Set(run);
        let cand = null;
        if (remTotal === 0) {
          cand = info('plane', run[len - 1], n, len);
        } else if (
          remTotal === len &&
          remEntries.every(([r, v]) => v <= 2 && !runSet.has(r))
        ) {
          cand = info('plane1', run[len - 1], n, len);
        } else if (
          remTotal === 2 * len &&
          remEntries.every(([r, v]) => v === 2 && !runSet.has(r))
        ) {
          cand = info('plane2', run[len - 1], n, len);
        }

        if (cand) {
          if (!best || cand.seq > best.seq ||
              (cand.seq === best.seq && WING_ORDER[cand.type] < WING_ORDER[best.type])) {
            best = cand;
          }
        }
      }
    }
    return best;
  }

  /**
   * 识别一组牌的牌型。含花牌（万能牌）时枚举其替代点数，
   * 取「最强合法解读」（炸弹优先，其次点数高的解读）。
   * @returns {{type:string,name:string,rank:number,length:number,seq:number}|null}
   */
  function analyze(input) {
    if (!input || input.length === 0) return null;
    const wilds = input.filter((c) => c.wild);
    if (!wilds.length) return analyzePlain(input);

    // 花牌 + 小王 + 大王 = 王炸
    if (input.length === 3) {
      const ranks = new Set(input.map((c) => c.rank));
      if (ranks.has(16) && ranks.has(17)) return info('rocket', 17, 3, 0);
    }

    const rest = input.filter((c) => !c.wild);
    let best = null;
    let bestPower = -Infinity;

    // 花牌替代 3..2；大王 / 小王只参与上面的王炸特例
    for (let r = 3; r <= 15; r++) {
      const virtual = rest.concat(wilds.map((w) => ({
        ...w, wild: false, rank: r, label: LABELS[r]
      })));
      const inf = analyzePlain(virtual);
      if (!inf) continue;
      const power = inf.type === 'rocket' ? 900
        : inf.type === 'bomb' ? 800 + inf.rank
        : inf.rank * 10 + inf.length;
      if (power > bestPower) {
        bestPower = power;
        best = inf;
      }
    }
    return best;
  }

  /** a 能否压过 b（b 为上一次出牌的信息，可为 null） */
  function beats(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.type === 'rocket') return b.type !== 'rocket';
    if (b.type === 'rocket') return false;
    if (a.type === 'bomb' && b.type !== 'bomb') return true;
    if (b.type === 'bomb' && a.type !== 'bomb') return false;
    if (a.type !== b.type) return false;
    if (a.length !== b.length) return false;
    return a.rank > b.rank;
  }

  function movePower(move) {
    const t = move.info.type;
    let p = move.info.rank + move.cards.length * 0.01;
    if (t === 'bomb') p += 40;
    if (t === 'rocket') p += 80;
    return p;
  }

  function sortByPower(moves) {
    return moves.sort((a, b) => {
      const d = movePower(a) - movePower(b);
      if (d !== 0) return d;
      return a.cards.length - b.cards.length;
    });
  }

  /**
   * 从「不含花牌」的手牌中枚举所有合法出牌（每种牌型给出若干带牌选择）。
   */
  function generatePlain(hand) {
    if (!hand || !hand.length) return [];
    const moves = [];
    const groups = groupCounts(hand);
    const ranks = Array.from(groups.keys()).sort((a, b) => a - b);
    const take = (r, k) => groups.get(r).slice(0, k);
    const push = (cards) => {
      const inf = analyze(cards);
      if (inf) moves.push({ cards: sortCards(cards), info: inf });
    };

    for (const r of ranks) {
      const g = groups.get(r);
      push(take(r, 1));
      if (g.length >= 2) push(take(r, 2));
      if (g.length >= 3) {
        push(take(r, 3));
        for (const o of ranks) {
          if (o === r) continue;
          push([...take(r, 3), ...take(o, 1)]);
          if (groups.get(o).length >= 2) push([...take(r, 3), ...take(o, 2)]);
        }
      }
      if (g.length === 4) {
        push(take(r, 4));
        const others = ranks.filter((x) => x !== r);
        for (let i = 0; i < others.length; i++) {
          for (let j = i + 1; j < others.length; j++) {
            push([...take(r, 4), ...take(others[i], 1), ...take(others[j], 1)]);
          }
        }
        const pairRanks = others.filter((x) => groups.get(x).length >= 2);
        for (let i = 0; i < pairRanks.length; i++) {
          for (let j = i + 1; j < pairRanks.length; j++) {
            push([...take(r, 4), ...take(pairRanks[i], 2), ...take(pairRanks[j], 2)]);
          }
        }
      }
    }

    // 王炸
    if (groups.has(16) && groups.has(17)) {
      push([...take(16, 1), ...take(17, 1)]);
    }

    // 顺子
    for (let len = 5; len <= 12; len++) {
      for (let start = 3; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let r = start; r < start + len; r++) {
          if (!groups.has(r)) { ok = false; break; }
        }
        if (!ok) continue;
        const cs = [];
        for (let r = start; r < start + len; r++) cs.push(groups.get(r)[0]);
        push(cs);
      }
    }

    // 连对
    for (let len = 3; len <= 12; len++) {
      for (let start = 3; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let r = start; r < start + len; r++) {
          if (!groups.has(r) || groups.get(r).length < 2) { ok = false; break; }
        }
        if (!ok) continue;
        const cs = [];
        for (let r = start; r < start + len; r++) cs.push(...take(r, 2));
        push(cs);
      }
    }

    // 飞机
    for (let len = 2; len <= 6; len++) {
      for (let start = 3; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let r = start; r < start + len; r++) {
          if (!groups.has(r) || groups.get(r).length < 3) { ok = false; break; }
        }
        if (!ok) continue;

        const base = [];
        const runSet = new Set();
        for (let r = start; r < start + len; r++) {
          base.push(...take(r, 3));
          runSet.add(r);
        }
        push(base);

        const wingSingles = [];
        for (const r of ranks) {
          if (!runSet.has(r)) for (const c of groups.get(r)) wingSingles.push(c);
        }
        wingSingles.sort((a, b) => a.rank - b.rank);
        if (wingSingles.length >= len) {
          push([...base, ...wingSingles.slice(0, len)]);
        }

        const wingPairs = [];
        for (const r of ranks) {
          if (!runSet.has(r) && groups.get(r).length >= 2) wingPairs.push(r);
        }
        if (wingPairs.length >= len) {
          push([...base, ...wingPairs.slice(0, len).flatMap((r) => take(r, 2))]);
        }
      }
    }

    // 去重
    const seen = new Set();
    const out = [];
    for (const m of moves) {
      const key = m.cards.map((c) => c.id).sort((a, b) => a - b).join(',');
      if (!seen.has(key)) {
        seen.add(key);
        out.push(m);
      }
    }
    return sortByPower(out);
  }

  /**
   * 枚举手牌的全部合法出牌。含花牌时逐一枚举其替代点数，
   * 收集所有「用上花牌」的组合，并与不含花牌的组合去重合并。
   */
  function generateMoves(hand) {
    if (!hand || !hand.length) return [];
    const wilds = hand.filter((c) => c.wild);
    if (!wilds.length) return generatePlain(hand);

    const rest = hand.filter((c) => !c.wild);
    const wildIds = new Set(wilds.map((w) => w.id));
    const byId = new Map(wilds.map((w) => [w.id, w]));
    const raw = generatePlain(rest);

    // 花牌 + 小王 + 大王 = 王炸
    const smallJoker = rest.find((c) => c.rank === 16);
    const bigJoker = rest.find((c) => c.rank === 17);
    if (smallJoker && bigJoker) {
      raw.push({
        cards: sortCards([wilds[0], smallJoker, bigJoker]),
        info: info('rocket', 17, 3, 0)
      });
    }

    for (let r = 3; r <= 15; r++) {
      const virtual = rest.concat(wilds.map((w) => ({
        ...w, wild: false, rank: r, label: LABELS[r]
      })));
      for (const m of generatePlain(virtual)) {
        if (!m.cards.some((c) => wildIds.has(c.id))) continue;
        raw.push({
          cards: sortCards(m.cards.map((c) => byId.get(c.id) || c)),
          info: m.info
        });
      }
    }

    const seen = new Set();
    const out = [];
    for (const m of raw) {
      const key =
        m.cards.map((c) => c.id).sort((a, b) => a - b).join(',') +
        '|' + m.info.type + '|' + m.info.rank + '|' + m.info.length;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return sortByPower(out);
  }

  function findBeatingMoves(hand, lastInfo) {
    return generateMoves(hand).filter((m) => beats(m.info, lastInfo));
  }

  function removeCards(hand, cards) {
    const ids = new Set(cards.map((c) => c.id));
    return hand.filter((c) => !ids.has(c.id));
  }

  function cardKey(cards) {
    return cards.map((c) => c.id).sort((a, b) => a - b).join(',');
  }

  global.Cards = {
    LABELS,
    TYPE_NAMES,
    createDeck,
    shuffle,
    sortCards,
    sortCardsDesc,
    groupCounts,
    analyze,
    beats,
    generateMoves,
    findBeatingMoves,
    sortByPower,
    movePower,
    removeCards,
    cardKey
  };
})(window);
