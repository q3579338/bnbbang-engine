/*
 * card —— 一个区块哈希对应的那份"参数证书"（纯函数版）
 * ------------------------------------------------------------
 * 哈希 → 派生 → 引擎 → card + cardHash。与服务端算的是同一件事、同一份算式，
 * 区别只在于这里不依赖 ethers（ABI 编码见 lib/abi.js）。
 *
 * cardHash 只用**整数**作基：blockHash + derive() 出来的 22 个整数槽 + 三个专用槽
 * （引力、两个参照系自由度）+ 结局序号 + 稀有度 + 推导版本。
 * 为什么不把浮点参数塞进去：22 个槽是 keccak 的直接产物，任何机器上逐位相同；
 * 而 params 里的浮点经过 Math.log/exp/cos/pow，这些函数的最后一个 ulp
 * 在不同 V8 版本/平台上并不保证一致。以整数为基，指纹才是真的可复现。
 *
 * 结局（outcome）本身是引擎跑浮点跑出来的，所以它带着上面那点不确定性。
 * 它被一起签进 cardHash 里 —— 这是有意的：签名就是"服务端在这个版本下算出的是这个结局"，
 * 而不是"全宇宙唯一真理"。版本号 DERIVATION_VERSION 用来区分。
 *
 * blockNumber **不参与** cardHash：它只是记录。同一个哈希换个高度算，指纹不变。
 */
'use strict';
const B = require('../engine/bnbhash.js');
const E = require('../engine/engine.js');
const ABI = require('./abi.js');

/** 结局顺序必须与合约 outcomeName() 一致。序号就是合约里的 uint8 outcome */
const OUTCOME_ORDER = [
  'UNSTABLE_ORBITS', 'BIG_CRUNCH', 'BIG_RIP', 'HEAT_DEATH_NO_STRUCTURE',
  'BLACK_HOLE_DOMINATED', 'NO_ATOMS', 'NO_CHEMISTRY', 'NO_STARS',
  'STARS_NO_LIFE', 'OBSERVERS_POSSIBLE', 'NO_CARBON_CHEMISTRY', 'BEYOND_MODEL_DIM'
];

/* 推导版本。改动任何影响数值的东西都必须把它 +1，否则新旧 card 会混在一起分不出来。
   v1：22 个哈希槽位定型。
   v2：G/c/h/e 四个常数各自独立 —— 补一个引力自由度 gNewton（专用槽 200），
       再从两个参照系自由度（槽 201/202）反解出四个比值。原来 22 个槽位一位没动。
   v3（2026-08-20）：弦气维度的「半开」判定从 ±0.25 收成 ±0.02 的临界窄带，
       分数维宇宙从 34% 降到 5.6%。这改变了同一个区块哈希算出来的 D、结局与稀有度，
       所以必须升版本 —— cardHash 里签着它，不升的话新旧两套卡会共用同一个指纹。
   版本号进 cardHash，意味着：**版本一升，链上老卡不重算**。老卡的 cardHash 是在老版本下
   签的，新代码算不出它，也不该算出它 —— 要复现 v2 的卡，去 checkout v2 的代码。 */
const DERIVATION_VERSION = 3;

/* 干预/造物卡指纹的序列化版本（原生卡走 uInt，不经过这套）。
   与服务端 /api/card 回包里 version 的第二段同值，即 "3-3"。
   2 = String(float)（跨平台 Math.pow 差 1 ulp 就会换指纹；仅验老卡）
   3 = unit 空间 uint32（与 ops 同一 1e9 刻度，整数基）
   字段本身不进 cardHash；验卡按卡上 cardShape 选算法，缺字段当 2。 */
const CARD_SHAPE = 3;

/* CODATA 2018 基准值。四个常数按 frame 里的倍率乘上去，
   得到"在声明的外部参照系里，这个宇宙的常数是多少"。 */
const SI0 = {
  c: 299792458,               // m/s
  h: 6.62607015e-34,          // J·s（普朗克常数本体，不是 ħ）
  e: 1.602176634e-19,         // C
  G: 6.67430e-11              // m³kg⁻¹s⁻²
};

/* 稀有度 0..4 = S/A/B/C/D。合约按它定价和发币，所以它必须**被签进摘要**。
   链上算不出来 —— 要知道维度和结局，那是引擎的事。
   实测占比（N=6000，2026-08-19 的标定）：
     S 能诞生观察者      1.53%
     A 三维但没活        0.62%
     B 整数维（非三维）  46.25%
     C 半整数维         28.55%
     D 一维及以下       23.05% */
function rarityOf(outcomeId, D) {
  if (outcomeId === 'OBSERVERS_POSSIBLE') return 0;              // S
  if (D != null && Math.abs(D - 3) < 1e-9) return 1;             // A
  if (D == null || D <= 1) return 4;                             // D
  if (Math.abs(D - Math.round(D)) < 1e-9) return 2;              // B
  return 3;                                                      // C
}
const RARITY_NAME = ['S', 'A', 'B', 'C', 'D'];

/** 跑引擎，取出结局序号 / 维度 / 稀有度。干预复算也走这一条 */
function simulateFor(params) {
  const r = E.simulate(params, { modules: B.MODULES_ON, register: false });
  const outcomeId = (r.outcome && r.outcome.id) || null;
  const outcomeIdx = OUTCOME_ORDER.indexOf(outcomeId);
  if (outcomeIdx < 0) throw new Error('引擎给出的结局不在合约的 OUTCOMES 里：' + outcomeId);
  const dims = (r.calc && r.calc.dims) || {};
  const D = dims.D == null ? null : dims.D;
  return { r, outcomeId, outcomeIdx, dims, D, rarity: rarityOf(outcomeId, D) };
}

function dimensionOf(dims, D) {
  return D == null ? null : {
    D: D,
    kind: dims.kind || null,                       // 'integer' | 'fractional' | 'three' …
    // 维度是弦气体算出来的，不是掷骰子：把三个输入原样带出来，谁都能复算
    stringGas: dims.emergent && dims.emergent.inputs ? dims.emergent.inputs : null,
    nOpen: dims.emergent ? dims.emergent.nOpen : null
  };
}

/**
 * 原生卡的 cardHash：
 *   keccak256(abi.encode(bytes32 blockHash, uint32[22] uInt, uint32 uG, uint32 uF1, uint32 uF2,
 *                        uint8 outcome, uint8 rarity, uint32 derivationVersion))
 * 全静态类型，编码就是 29 个 32 字节字顺序排开。
 */
function nativeCardHash(hash, uInt, frame, outcomeIdx, rarity) {
  if (uInt.length !== 22) throw new Error('uInt 必须是 22 个槽');
  const words = [ABI.encBytes32(hash)]
    .concat(uInt.map(ABI.encUint))
    .concat([frame.uG, frame.uF1, frame.uF2, outcomeIdx, rarity, DERIVATION_VERSION].map(ABI.encUint));
  return ABI.keccak256(ABI.encodeWords(words));
}

/**
 * @param {string} blockHash 0x 开头的 32 字节
 * @param {number|null} [blockNumber] 区块高度（不参与派生、不进 cardHash，只是记录）
 * @returns {{cardHash:string, card:object}}
 */
function buildCard(blockHash, blockNumber) {
  const hash = B.normHash(blockHash);
  const d = B.derive(hash);
  const s = simulateFor(d.params);
  const f = d.frame;
  const cardHash = nativeCardHash(hash, d.uInt, f, s.outcomeIdx, s.rarity);
  const r = s.r;

  return {
    cardHash,
    card: {
      blockHash: hash,
      blockNumber: blockNumber == null ? null : Number(blockNumber),
      derivationVersion: DERIVATION_VERSION,
      cardShape: CARD_SHAPE,
      engineVersion: r.version || null,
      tier: { id: d.tier.id, name: d.tier.name, scale: d.tier.scale, p: d.tier.p },
      outcome: { index: s.outcomeIdx, id: s.outcomeId, name: r.outcome.name, observers: !!r.outcome.observers },
      rarity: { index: s.rarity, name: RARITY_NAME[s.rarity] },
      dimension: dimensionOf(s.dims, s.D),
      /* 四个基本常数在**外部参照系**里的值。物理内容仍然只有 α 和 α_G 两个；
         ħ_r、c_r 两个自由度是参照系的选择，宇宙内部的观察者测不出来。 */
      constants: {
        frame: 'external',
        c:    { si: SI0.c * f.cRel,    ratio: f.cRel,    unit: 'm/s' },
        h:    { si: SI0.h * f.hbarRel, ratio: f.hbarRel, unit: 'J·s' },
        e:    { si: SI0.e * f.eRel,    ratio: f.eRel,    unit: 'C' },
        G:    { si: SI0.G * f.GRel,    ratio: f.GRel,    unit: 'm³kg⁻¹s⁻²' },
        alpha: r.constants ? r.constants.alpha : null,
        alphaInv: r.constants && r.constants.alpha ? 1 / r.constants.alpha : null,
        alphaGRel: (r.calc && r.calc.stars) ? r.calc.stars.alphaGRel : null
      },
      params: d.params,
      uInt: d.uInt,                                    // 22 个整数槽：cardHash 的基，也是复算的入口
      frameSlots: { uG: f.uG, uF1: f.uF1, uF2: f.uF2 },  // 三个专用槽（200/201/202），同样进 cardHash
      modules: d.modules
    }
  };
}

module.exports = {
  buildCard, nativeCardHash, simulateFor, dimensionOf,
  OUTCOME_ORDER, DERIVATION_VERSION, CARD_SHAPE, rarityOf, RARITY_NAME, SI0
};
