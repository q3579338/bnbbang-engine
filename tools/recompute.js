#!/usr/bin/env node
/*
 * recompute —— 从一个 BNB 区块哈希复算出那个宇宙
 *
 *   node tools/recompute.js <区块哈希>                 原生卡：参数、结局、稀有度、cardHash
 *   node tools/recompute.js <区块哈希> --ops 0x…       拯救/造物卡：按 ops 把参数搬到位再算
 *   node tools/recompute.js <区块哈希> --json          整份 card 按 JSON 输出（可直接 diff 服务端 /api/card 回包）
 *
 * 不联网、不读任何存档。同一个输入在任何机器上给出同一个 cardHash。
 */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'lib', 'index.js'));

function usage(msg) {
  if (msg) console.error('错误：' + msg + '\n');
  console.error('用法：node tools/recompute.js <0x区块哈希> [--ops 0x…] [--json]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let hash = null, opsHex = null, asJson = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ops') { opsHex = argv[++i]; if (!opsHex) usage('--ops 后面要跟十六进制'); }
  else if (a === '--json') asJson = true;
  else if (a === '-h' || a === '--help') usage();
  else if (!hash) hash = a;
  else usage('多余的参数：' + a);
}
if (!hash) usage('缺区块哈希');

let h;
try { h = L.normHash(hash); } catch (e) { usage(e.message); }

function fmt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toPrecision(10).replace(/\.?0+$/, '');
  return String(v);
}
function printCard(title, card, cardHash, extra) {
  console.log('== ' + title);
  console.log('blockHash          ' + card.blockHash);
  console.log('derivationVersion  ' + card.derivationVersion + '    cardShape ' + L.CARD_SHAPE + '    engine ' + card.engineVersion);
  console.log('tier               ' + card.tier.id + '（' + card.tier.name + '）scale=' + card.tier.scale + ' p=' + card.tier.p);
  console.log('outcome            #' + card.outcome.index + ' ' + card.outcome.id + '（' + card.outcome.name + '）');
  console.log('rarity             #' + card.rarity.index + ' ' + card.rarity.name);
  if (card.dimension) {
    console.log('dimension          D=' + card.dimension.D + ' (' + card.dimension.kind + ', nOpen=' + card.dimension.nOpen + ')');
  } else {
    console.log('dimension          （无）');
  }
  const c = card.constants;
  console.log('constants(ext)     c=' + fmt(c.c.si) + ' m/s ×' + fmt(c.c.ratio) + '   h=' + c.h.si.toExponential(6) + ' ×' + fmt(c.h.ratio));
  console.log('                   e=' + c.e.si.toExponential(6) + ' ×' + fmt(c.e.ratio) + '   G=' + c.G.si.toExponential(6) + ' ×' + fmt(c.G.ratio));
  console.log('alpha              1/' + fmt(c.alphaInv));
  console.log('params');
  Object.keys(card.params).forEach((k) => {
    const mark = extra && extra.movedKeys && extra.movedKeys[k] ? '   ← ops' : '';
    console.log('  ' + k.padEnd(18) + fmt(card.params[k]) + mark);
  });
  if (card.uInt) console.log('uInt[22]           ' + card.uInt.join(' '));
  if (card.frameSlots) console.log('slots 200/201/202  ' + card.frameSlots.uG + ' ' + card.frameSlots.uF1 + ' ' + card.frameSlots.uF2);
  console.log('cardHash           ' + cardHash);
}

if (!opsHex) {
  const { card, cardHash } = L.buildCard(h, null);
  if (asJson) { console.log(JSON.stringify({ card, cardHash, version: card.derivationVersion + '-' + L.CARD_SHAPE }, null, 2)); process.exit(0); }
  printCard('原生卡（blockHash 唯一决定）', card, cardHash);
  process.exit(0);
}

let r;
try { r = L.recomputeWithOps(h, opsHex); } catch (e) { usage(e.message); }
if (asJson) { console.log(JSON.stringify({ card: r.card, cardHash: r.cardHash, opsHash: r.opsHash, nativeCardHash: r.native.cardHash }, null, 2)); process.exit(0); }
console.log('== 原生卡');
console.log('outcome            #' + r.native.card.outcome.index + ' ' + r.native.card.outcome.id + '    rarity ' + r.native.card.rarity.name
  + (r.native.card.dimension ? '    D=' + r.native.card.dimension.D : ''));
console.log('cardHash           ' + r.native.cardHash);
console.log('== ops');
console.log('ops                ' + opsHex);
console.log('opsHash            ' + r.opsHash);
r.card.intervention.moved.forEach((m) => {
  console.log('  [' + m.index + '] ' + m.key.padEnd(18) + 'unit ' + m.unitInt + '/1e9 = ' + m.unit + '    ' + fmt(m.from) + ' → ' + fmt(m.to));
});
const movedKeys = {}; r.card.intervention.moved.forEach((m) => { movedKeys[m.key] = true; });
printCard('干预后的卡（derive(blockHash) + ops）' + (r.card.intervention.rescued ? '  ★ 救活' : ''), r.card, r.cardHash, { movedKeys });
