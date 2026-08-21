/*
 * ops —— 干预/造物的位移记录：编码、解码、复算
 * ------------------------------------------------------------
 * 原生卡由区块哈希唯一决定；被干预过的卡（拯救）和造物卡多了一段**人写的历史**：
 * 推了哪几个参数、各推到哪。这段历史就是 ops。
 *
 *   拯救（MirrorUniverse.intervene）：ops 原样进 calldata，合约把 keccak256(ops) 签进摘要
 *   造物（MirrorCrafted.mintCrafted）：链上只存 opsHash = keccak256(ops)，ops 本体由持有者/服务端保管
 *
 * 编码（与合约注释、服务端三处必须同步）：
 *   每 5 字节一条：uint8 参数下标 ‖ uint32 干预后该参数在 unit 空间的位置 × 1e9（大端）
 *   下标 = 在 paramsFor(MODULES_ON) 里的位置（PARAM_KEYS）；按下标升序拼接，不许重复。
 *
 * ops 记的是**绝对位置**而不是位移量，基准固定取原生参数（blockHash 派生出来的那份）。
 * 所以一枚被干预过 N 次的 NFT，最后那笔交易的 ops 就足以复原它 —— 不需要翻历史。
 *
 * 刻度取 1e9：派生本来就是 u = n / 1e9，1e9 以内的整数 double 能精确表示，跨机器不会差一个 ulp。
 * 服务端是**先量化再模拟**（量化 → fromUnit → simulate），所以链上记的位置就是它实际用的位置；
 * 复算的人走同一条路，才会得到同一个结局。
 *
 * 这个文件里**没有**定价：推一格多长（STEP）、一格多少 BANG（UNIT_COST）都是服务端的事，
 * 复算不需要它们 —— ops 里是终点位置，不是步数。
 */
'use strict';
const B = require('../engine/bnbhash.js');
const P = require('../engine/params.js');
const ABI = require('./abi.js');
const CARD = require('./card.js');

const MOD = B.MODULES_ON;
const OPS_SCALE = 1e9;                 // 与合约 U_DEN 同一个刻度
const OPS_ITEM_BYTES = 5;              // uint8 + uint32
/** 参数下标表。ops 里只写下标不写名字：名字是变长的，而链上要的是定长可解析 */
const PARAM_KEYS = P.paramsFor(MOD).map((d) => d.key);
const PARAM_INDEX = {};
PARAM_KEYS.forEach((k, i) => { PARAM_INDEX[k] = i; });

/** unit → 整数刻度。夹在 [0, OPS_SCALE] */
function quantizeUnit(u) {
  const n = Math.round(Math.min(1, Math.max(0, Number(u) || 0)) * OPS_SCALE);
  return Math.min(OPS_SCALE, Math.max(0, n));
}
/** 整数刻度 → unit。复算的人也走这一步，所以它必须是 quantizeUnit 的严格逆 */
function unquantize(n) { return n / OPS_SCALE; }

/**
 * [{key|index, unitInt}] → '0x…'。按下标升序，重复下标直接报错
 * （同一个参数出现两次的话，"最终位置"就有两个答案，复算的人只能猜）。
 */
function encodeOps(entries) {
  const list = (entries || []).map((e) => {
    const idx = e.index != null ? Number(e.index) : PARAM_INDEX[e.key];
    if (!Number.isInteger(idx) || idx < 0 || idx > 255 || !PARAM_KEYS[idx]) {
      throw new Error('ops 下标越界：' + (e.key || e.index));
    }
    const n = Number(e.unitInt);
    if (!Number.isInteger(n) || n < 0 || n > OPS_SCALE) throw new Error('ops 的 unit 刻度越界：' + n);
    return { index: idx, unitInt: n };
  }).sort((a, b) => a.index - b.index);

  const buf = Buffer.alloc(list.length * OPS_ITEM_BYTES);
  list.forEach((e, i) => {
    if (i > 0 && list[i - 1].index === e.index) throw new Error('同一个参数在 ops 里出现了两次：' + PARAM_KEYS[e.index]);
    buf.writeUInt8(e.index, i * OPS_ITEM_BYTES);
    buf.writeUInt32BE(e.unitInt, i * OPS_ITEM_BYTES + 1);
  });
  return '0x' + buf.toString('hex');
}

/**
 * '0x…' → [{index, key, unitInt, unit}]。**这是复算的入口**。
 * 校验从严：链上的字节改不了，读出一堆似是而非的东西比直接报错危险得多。
 */
function decodeOps(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('ops 不是十六进制');
  if (h.length === 0) throw new Error('ops 是空的');
  if (h.length % (OPS_ITEM_BYTES * 2) !== 0) throw new Error('ops 长度不是 ' + OPS_ITEM_BYTES + ' 字节的整数倍');
  const buf = Buffer.from(h, 'hex');
  const out = [];
  for (let i = 0; i < buf.length; i += OPS_ITEM_BYTES) {
    const index = buf.readUInt8(i);
    const key = PARAM_KEYS[index];
    if (!key) throw new Error('ops 里的参数下标不存在：' + index);
    if (out.length && out[out.length - 1].index >= index) throw new Error('ops 没有按下标升序（或有重复）');
    const unitInt = buf.readUInt32BE(i + 1);
    if (unitInt > OPS_SCALE) throw new Error('ops 的 unit 刻度超过 ' + OPS_SCALE + '：' + unitInt);
    out.push({ index, key, unitInt, unit: unquantize(unitInt) });
  }
  return out;
}

/**
 * 复算：把 ops 记的位置搬到一份基准参数上。
 * @param {object} baseParams 基准（**原生**参数，即 blockHash 派生出来的那份）
 * @param {string} hex        链上那段 ops
 * @returns {object} normalize 过的完整参数，可以直接喂给引擎
 */
function applyOpsHex(baseParams, hex) {
  const out = P.normalize(baseParams, MOD);
  decodeOps(hex).forEach((e) => { out[e.key] = P.fromUnit(e.key, e.unit); });
  return P.normalize(out, MOD);
}

/**
 * 干预/造物卡的 cardHash。原生卡用 22 个整数槽作基，干预后参数已经不是槽位能代表的了，
 * 改成对**归一化后的参数**逐项取字符串指纹：
 *   fp       = keccak256(abi.encode(string[] keys（按字典序）, string[] String(value)))
 *   cardHash = keccak256(abi.encode(bytes32 blockHash, bytes32 fp, uint8 outcome, uint8 rarity, uint32 derivationVersion))
 * String(value) 是 JS 的 Number→String（最短往返表示），Node 各版本一致。
 */
function cardHashOf(blockHash, normalizedParams, outcomeIdx, rarity) {
  const keys = Object.keys(normalizedParams).sort();
  const fp = ABI.keccak256(ABI.encodeStringPair(keys, keys.map((k) => String(normalizedParams[k]))));
  return ABI.keccak256(ABI.encodeWords([
    ABI.encBytes32(B.normHash(blockHash)), ABI.encBytes32(fp),
    ABI.encUint(outcomeIdx), ABI.encUint(rarity), ABI.encUint(CARD.DERIVATION_VERSION)
  ]));
}

/** ops 的哈希 = keccak256(ops 的原始字节)。合约里就是 keccak256(ops)；造物卡链上存的 opsHash 也是它 */
function opsHashOf(opsHex) {
  const h = String(opsHex || '');
  return ABI.keccak256(h.startsWith('0x') ? h : '0x' + h);
}

/**
 * 一步到位：blockHash + ops → 干预后的卡。
 * 只用这两样输入，不需要服务端的任何存档 —— 这正是 ops 上链的理由。
 * @returns {{cardHash:string, opsHash:string, card:object, native:{cardHash:string, card:object}}}
 */
function recomputeWithOps(blockHash, opsHex) {
  const native = CARD.buildCard(blockHash, null);
  const params = applyOpsHex(native.card.params, opsHex);
  const s = CARD.simulateFor(params);
  const cardHash = cardHashOf(native.card.blockHash, params, s.outcomeIdx, s.rarity);
  const moved = decodeOps(opsHex).map((e) => ({
    index: e.index, key: e.key, unitInt: e.unitInt, unit: e.unit,
    from: native.card.params[e.key], to: params[e.key]
  }));
  return {
    cardHash,
    opsHash: opsHashOf(opsHex),
    native,
    card: {
      blockHash: native.card.blockHash,
      derivationVersion: CARD.DERIVATION_VERSION,
      engineVersion: s.r.version || null,
      tier: native.card.tier,
      outcome: { index: s.outcomeIdx, id: s.outcomeId, name: s.r.outcome.name, observers: !!s.r.outcome.observers },
      rarity: { index: s.rarity, name: CARD.RARITY_NAME[s.rarity] },
      dimension: CARD.dimensionOf(s.dims, s.D),
      constants: native.card.constants,     // 常数由 frame 决定，干预不动它们
      params,
      uInt: native.card.uInt,
      modules: MOD,
      intervention: {
        from: { outcome: native.card.outcome.id, D: native.card.dimension ? native.card.dimension.D : null },
        moved,
        rescued: s.outcomeId === 'OBSERVERS_POSSIBLE' && native.card.outcome.id !== 'OBSERVERS_POSSIBLE'
      }
    }
  };
}

module.exports = {
  encodeOps, decodeOps, applyOpsHex, cardHashOf, opsHashOf, recomputeWithOps,
  quantizeUnit, unquantize, OPS_SCALE, OPS_ITEM_BYTES, PARAM_KEYS, PARAM_INDEX
};
