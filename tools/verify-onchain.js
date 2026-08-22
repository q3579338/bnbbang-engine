#!/usr/bin/env node
/*
 * verify-onchain —— 读链上的一枚 NFT，本地复算，比对 cardHash
 *
 *   node tools/verify-onchain.js <tokenId>                       原生系列（MirrorUniverse）
 *   node tools/verify-onchain.js <tokenId> --tx 0x…              被拯救过的：从那笔 intervene 交易里取 ops
 *   node tools/verify-onchain.js <tokenId> --ops 0x…             直接给 ops
 *   node tools/verify-onchain.js <tokenId> --crafted --ops 0x…   造物系列（MirrorCrafted）：链上只有 opsHash，ops 要自己带
 *
 *   --contract 0x…   合约地址（默认：BSC 测试网现役 MirrorUniverse）
 *   --rpc URL        JSON-RPC 节点（默认：BSC 测试网公共节点）
 *   --no-scan        原生复算对不上时不去扫 Intervened 事件
 *
 * 只用 eth_call / eth_getTransactionByHash / eth_getLogs 三个只读方法，不需要钱包。
 * 退出码 0 = 链上 cardHash 与本地复算逐位相同；1 = 不一致或没法判定。
 */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'lib', 'index.js'));

/* 现役测试网（与站点 config.js 同值）。换链 / 主网上线后改这里或用参数覆盖。 */
const DEFAULTS = {
  rpc: 'https://bsc-testnet-rpc.publicnode.com',
  contract: '0xf8b2033cfdec1a52f1a31ce61ee092a688eb7740',   // MirrorUniverse v5，chainId 97
  crafted: ''                                                // MirrorCrafted：测试网尚未部署
};

const SEL = {
  universeOf: sel('universeOf(uint256)'),
  cardOf: sel('cardOf(uint256)'),
  signer: sel('signer()'),
  intervene: sel('intervene(uint256,bytes32,uint8,uint8,uint256,uint64,bytes,bytes)'),
  mintCrafted: sel('mintCrafted(bytes32,uint64,bytes32,bytes32,uint8,uint8,uint256,uint64,bytes)')
};
const TOPIC_INTERVENED = L.keccak256('Intervened(uint256,address,uint8,uint8,uint256,bool)');

function sel(sig) { return L.keccak256(sig).slice(0, 10); }
function word(hex, i) { return hex.slice(2 + 64 * i, 2 + 64 * (i + 1)); }
function wAddr(hex, i) { return '0x' + word(hex, i).slice(24); }
function wInt(hex, i) { return parseInt(word(hex, i), 16); }
function wBig(hex, i) { return BigInt('0x' + word(hex, i)); }
function uintArg(n) { return BigInt(n).toString(16).padStart(64, '0'); }
const ZERO32 = '0x' + '0'.repeat(64);

function usage(msg) {
  if (msg) console.error('错误：' + msg + '\n');
  console.error('用法：node tools/verify-onchain.js <tokenId> [--tx 0x…] [--ops 0x…] [--crafted] [--contract 0x…] [--rpc URL] [--no-scan]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const opt = { tokenId: null, tx: null, ops: null, crafted: false, contract: null, rpc: DEFAULTS.rpc, scan: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tx') opt.tx = argv[++i];
  else if (a === '--ops') opt.ops = argv[++i];
  else if (a === '--crafted') opt.crafted = true;
  else if (a === '--contract') opt.contract = argv[++i];
  else if (a === '--rpc') opt.rpc = argv[++i];
  else if (a === '--no-scan') opt.scan = false;
  else if (a === '-h' || a === '--help') usage();
  else if (opt.tokenId == null) opt.tokenId = a;
  else usage('多余的参数：' + a);
}
if (opt.tokenId == null || !/^\d+$/.test(opt.tokenId)) usage('tokenId 要是非负整数');
if (!opt.contract) opt.contract = opt.crafted ? DEFAULTS.crafted : DEFAULTS.contract;
if (!/^0x[0-9a-fA-F]{40}$/.test(opt.contract || '')) usage(opt.crafted ? '造物合约地址未配置，请用 --contract 指定' : '合约地址不合法');
opt.contract = opt.contract.toLowerCase();

async function rpc(method, params) {
  const res = await fetch(opt.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error('RPC HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error('RPC ' + method + '：' + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}
const call = (data) => rpc('eth_call', [{ to: opt.contract, data }, 'latest']);

function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function line(k, v) { console.log(k.padEnd(20) + v); }
function verdict(ok, msg) { console.log((ok ? '\n✓ ' : '\n✗ ') + msg); process.exit(ok ? 0 : 1); }

function shapeNote(sh) {
  return Number(sh) <= 2 ? '（老卡 String(float)）' : '（现役 uint32 unitInt）';
}

/** 链上不存 cardShape。先试现役 3，对不上再试老卡 2，按能对上链上 cardOf 的那套算。 */
function recomputeByCardShape(blockHash, ops, wantHash) {
  const r3 = L.recomputeWithOps(blockHash, ops, 3);
  if (same(r3.cardHash, wantHash)) return { r: r3, shape: 3 };
  const r2 = L.recomputeWithOps(blockHash, ops, 2);
  if (same(r2.cardHash, wantHash)) return { r: r2, shape: 2 };
  return { r: r3, shape: 3 };
}

/** 从 intervene(...) 的 calldata 里取 ops（第 7 个参数，动态 bytes） */
function opsFromInterveneInput(input) {
  if (!input.startsWith(SEL.intervene)) throw new Error('这笔交易不是 intervene()：选择器 ' + input.slice(0, 10) + '，期望 ' + SEL.intervene);
  const body = '0x' + input.slice(10);
  const id = wBig(body, 0);
  const off = wInt(body, 6);                           // ops 的偏移（相对 body 起点）
  const len = parseInt(body.slice(2 + off * 2, 2 + off * 2 + 64), 16);
  const ops = '0x' + body.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2);
  return { id, ops, newCardHash: '0x' + word(body, 1), newOutcome: wInt(body, 2), newRarity: wInt(body, 3) };
}

/** 扫最近的 Intervened 事件，找这枚 token 最后一笔。公共节点一次最多 5 万块，分段扫 */
async function scanLastIntervene(tokenId, maxBlocks) {
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const STEP = 40000;
  let found = null;
  for (let to = latest; to > latest - maxBlocks; to -= STEP) {
    const from = Math.max(0, to - STEP + 1);
    const logs = await rpc('eth_getLogs', [{
      address: opt.contract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      topics: [TOPIC_INTERVENED, '0x' + uintArg(tokenId)]
    }]);
    if (logs.length) {
      // 同一段里取区块号最大、同块里 logIndex 最大的那条 = 最后一次干预
      logs.sort((a, b) => (parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16)) || (parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)));
      found = logs[logs.length - 1];
      break;
    }
  }
  return found;
}

async function verifyNative() {
  const id = opt.tokenId;
  const u = await call(SEL.universeOf + uintArg(id));
  if (!u || u.length < 2 + 64 * 7) verdict(false, '读不出 universeOf(' + id + ')：合约地址或 ABI 不对');
  const blockHash = '0x' + word(u, 0);
  if (blockHash === ZERO32) verdict(false, '链上没有 token #' + id);
  const onchain = {
    blockHash, blockNumber: wInt(u, 1), mintedAt: wInt(u, 2), minter: wAddr(u, 3),
    outcome: wInt(u, 4), verified: wInt(u, 5) === 1, rarity: wInt(u, 6),
    cardHash: await call(SEL.cardOf + uintArg(id))
  };
  const signer = wAddr(await call(SEL.signer), 0);

  console.log('== 链上  MirrorUniverse ' + opt.contract + '  token #' + id);
  line('blockHash', onchain.blockHash);
  line('blockNumber', String(onchain.blockNumber) + (onchain.verified ? '（铸造时 blockhash() 当场核对过）' : '（铸造时超出 256 块窗口，链上未核对）'));
  line('outcome', '#' + onchain.outcome + ' ' + L.OUTCOME_ORDER[onchain.outcome]);
  line('rarity', '#' + onchain.rarity + ' ' + L.RARITY_NAME[onchain.rarity]);
  line('cardOf', onchain.cardHash);
  line('signer()', signer);
  if (onchain.cardHash === ZERO32) verdict(false, 'cardOf 是 0：这枚 NFT 没走服务端签名，链上明说它不带参数，无可复算');

  const nat = L.buildCard(onchain.blockHash, onchain.blockNumber);
  console.log('\n== 本地  derive(blockHash) → 引擎');
  line('outcome', '#' + nat.card.outcome.index + ' ' + nat.card.outcome.id);
  line('rarity', '#' + nat.card.rarity.index + ' ' + nat.card.rarity.name + (nat.card.dimension ? '    D=' + nat.card.dimension.D : ''));
  line('cardHash', nat.cardHash);

  if (same(nat.cardHash, onchain.cardHash)) {
    const okMeta = nat.card.outcome.index === onchain.outcome && nat.card.rarity.index === onchain.rarity;
    verdict(okMeta, '原生卡：本地复算的 cardHash 与链上 cardOf 逐位相同' + (okMeta ? '，结局与稀有度也一致' : '，但结局/稀有度对不上（不应发生）'));
  }

  // 对不上 → 这枚卡被干预过，需要最后一笔 intervene 的 ops
  console.log('\n原生 cardHash 与链上不一致 → 这枚 NFT 被干预过，需要最后一笔 intervene 的 ops');
  let ops = opt.ops, src = '--ops';
  if (!ops && opt.tx) {
    const tx = await rpc('eth_getTransactionByHash', [opt.tx]);
    if (!tx) verdict(false, '找不到交易 ' + opt.tx);
    if (!same(tx.to, opt.contract)) verdict(false, '这笔交易不是发给这个合约的：to=' + tx.to);
    const d = opsFromInterveneInput(tx.input);
    if (d.id !== BigInt(id)) verdict(false, '这笔 intervene 操作的是 token #' + d.id + '，不是 #' + id);
    ops = d.ops; src = 'tx ' + opt.tx;
  }
  if (!ops && opt.scan) {
    console.log('正在扫最近 40 万块的 Intervened 事件（--no-scan 可跳过）…');
    const log = await scanLastIntervene(id, 400000);
    if (log) {
      const tx = await rpc('eth_getTransactionByHash', [log.transactionHash]);
      const d = opsFromInterveneInput(tx.input);
      ops = d.ops; src = 'tx ' + log.transactionHash + '（block ' + parseInt(log.blockNumber, 16) + '）';
    }
  }
  if (!ops) {
    verdict(false, '拿不到 ops。到区块浏览器找这枚 token 最后一笔 Intervened 事件（topic0 ' + TOPIC_INTERVENED + '），把交易哈希用 --tx 传进来');
  }

  const picked = recomputeByCardShape(onchain.blockHash, ops, onchain.cardHash);
  const r = picked.r;
  console.log('\n== 本地  derive(blockHash) + ops → 引擎');
  line('ops 来源', src);
  line('ops', ops);
  line('opsHash', r.opsHash);
  line('cardShape', String(r.card.cardShape) + shapeNote(r.card.cardShape));
  r.card.intervention.moved.forEach((m) => line('  [' + m.index + '] ' + m.key, m.from + ' → ' + m.to + '（unit ' + m.unitInt + '/1e9）'));
  line('outcome', '#' + r.card.outcome.index + ' ' + r.card.outcome.id);
  line('rarity', '#' + r.card.rarity.index + ' ' + r.card.rarity.name + (r.card.dimension ? '    D=' + r.card.dimension.D : ''));
  line('cardHash', r.cardHash);
  const ok = same(r.cardHash, onchain.cardHash) && r.card.outcome.index === onchain.outcome && r.card.rarity.index === onchain.rarity;
  verdict(ok, ok
    ? '干预卡：只用 blockHash + ops 复算出的 cardHash 与链上 cardOf 逐位相同' + (r.card.intervention.rescued ? '（从 ' + r.card.intervention.from.outcome + ' 救活）' : '')
      + '（cardShape=' + r.card.cardShape + '）'
    : '复算结果与链上不一致：cardHash ' + (same(r.cardHash, onchain.cardHash) ? '同' : '异') + '，outcome ' + r.card.outcome.index + ' vs ' + onchain.outcome + '，rarity ' + r.card.rarity.index + ' vs ' + onchain.rarity
      + '。已按 cardShape 3 再 2 各算一遍。可能是 ops 不是最后一笔，或者本地引擎版本与签名时不同（derivationVersion / cardShape 见 README）');
}

async function verifyCrafted() {
  const id = opt.tokenId;
  const c = await call(SEL.cardOf + uintArg(id));
  if (!c || c.length < 2 + 64 * 7) verdict(false, '读不出 cardOf(' + id + ')：合约地址或 ABI 不对');
  const onchain = {
    originHash: '0x' + word(c, 0), opsHash: '0x' + word(c, 1), cardHash: '0x' + word(c, 2),
    outcome: wInt(c, 3), rarity: wInt(c, 4), originBlock: wInt(c, 5), paid: wBig(c, 6)
  };
  if (onchain.cardHash === ZERO32) verdict(false, '链上没有造物 #' + id);
  console.log('== 链上  MirrorCrafted ' + opt.contract + '  token #' + id);
  line('originHash', onchain.originHash);
  line('originBlock', String(onchain.originBlock));
  line('opsHash', onchain.opsHash);
  line('cardHash', onchain.cardHash);
  line('outcome', '#' + onchain.outcome + ' ' + L.OUTCOME_ORDER[onchain.outcome]);
  line('rarity', '#' + onchain.rarity + ' ' + L.RARITY_NAME[onchain.rarity]);
  line('paid', onchain.paid.toString() + ' wei BANG');
  if (!opt.ops) verdict(false, '造物的 ops 不在链上（只存 opsHash），请用 --ops 传入持有者/服务端给的 ops；链上的 opsHash 会验证它没被改过');

  const picked = recomputeByCardShape(onchain.originHash, opt.ops, onchain.cardHash);
  const r = picked.r;
  console.log('\n== 本地  derive(originHash) + ops → 引擎');
  line('opsHash', r.opsHash + (same(r.opsHash, onchain.opsHash) ? '  = 链上' : '  ≠ 链上（ops 不是签名时那份）'));
  line('cardShape', String(r.card.cardShape) + shapeNote(r.card.cardShape));
  r.card.intervention.moved.forEach((m) => line('  [' + m.index + '] ' + m.key, m.from + ' → ' + m.to + '（unit ' + m.unitInt + '/1e9）'));
  line('outcome', '#' + r.card.outcome.index + ' ' + r.card.outcome.id);
  line('rarity', '#' + r.card.rarity.index + ' ' + r.card.rarity.name + (r.card.dimension ? '    D=' + r.card.dimension.D : ''));
  line('cardHash', r.cardHash);
  const ok = same(r.opsHash, onchain.opsHash) && same(r.cardHash, onchain.cardHash)
    && r.card.outcome.index === onchain.outcome && r.card.rarity.index === onchain.rarity;
  verdict(ok, ok ? '造物卡：opsHash 与 cardHash 都与链上逐位相同（cardShape=' + r.card.cardShape + '）' : '复算结果与链上不一致（已按 cardShape 3 再 2 各算一遍）');
}

(opt.crafted ? verifyCrafted() : verifyNative()).catch((e) => {
  console.error('出错：' + (e && e.message));
  process.exit(1);
});
