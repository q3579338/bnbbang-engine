/*
 * bnbbang-engine —— 区块哈希 → 宇宙 的完整推导链，零依赖
 *
 *   const { buildCard, recomputeWithOps } = require('bnbbang-engine');
 *   buildCard('0x…')                      → { cardHash, card }         原生卡
 *   recomputeWithOps('0x…', '0x…'[, shape]) → { cardHash, opsHash, card } 拯救/造物卡
 *   cardHashFromCard(card)                → 按卡上 cardShape 选算法（缺字段 = 2）
 */
'use strict';
const bnbhash = require('../engine/bnbhash.js');
const params = require('../engine/params.js');
const engine = require('../engine/engine.js');
const abi = require('./abi.js');
const card = require('./card.js');
const ops = require('./ops.js');

module.exports = Object.assign({}, card, ops, {
  bnbhash, params, engine, abi,
  derive: bnbhash.derive,
  normHash: bnbhash.normHash,
  keccak256: bnbhash.keccak256
});
