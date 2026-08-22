/*
 * abi —— cardHash 用到的那一小块 ABI 编码，零依赖
 * ------------------------------------------------------------
 * cardHash 的定义是 keccak256(abi.encode(...))，服务端用 ethers 的 AbiCoder 算。
 * 这里不引 ethers：复算仓库的承诺是「clone 下来就能算」，一个依赖都不该有。
 * 只实现用得到的三种形状：
 *   ① 全静态元组（bytes32 / uintN / uint32[22] / uint8）—— 原生卡的 cardHash
 *   ② abi.encode(string[], string[])                   —— 干预/造物卡指纹，cardShape=2（老卡）
 *   ③ abi.encode(string[], uint32[])                   —— 干预/造物卡指纹，cardShape=3（现役整数基）
 * 与 ethers 的输出逐字节一致，test/derivation.test.js 用链上真实 cardHash 反证过。
 */
'use strict';
const B = require('../engine/bnbhash.js');

const WORD = 32;

function isHex(s) { return /^0x[0-9a-fA-F]*$/.test(s); }

/** 整数 → 32 字节大端字（uint8 / uint32 / uint64 / uint256 都是同一种编码） */
function encUint(n) {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n || v >= (1n << 256n)) throw new Error('uint 越界：' + n);
  return v.toString(16).padStart(64, '0');
}

/** bytes32 —— 必须恰好 32 字节 */
function encBytes32(h) {
  const s = String(h);
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('不是 bytes32：' + h);
  return s.slice(2).toLowerCase();
}

/** address —— 左补零到 32 字节 */
function encAddress(a) {
  const s = String(a);
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('不是地址：' + a);
  return s.slice(2).toLowerCase().padStart(64, '0');
}

/** 一串 32 字节字 → '0x…'。用于全静态元组：静态类型逐个排开，没有偏移量 */
function encodeWords(words) { return '0x' + words.join(''); }

/** UTF-8 字符串 → 长度字 ‖ 数据（右补零到 32 的整数倍） */
function encString(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  const padLen = (WORD - (bytes.length % WORD)) % WORD;
  return encUint(bytes.length) + bytes.toString('hex') + '00'.repeat(padLen);
}

/**
 * string[] 的编码：长度字 ‖ 每个元素的偏移（相对于长度字之后的位置）‖ 各元素本体。
 * 动态类型的数组，元素本体只能放在头部之后，头部里放偏移。
 */
function encStringArray(arr) {
  const items = arr.map(encString);
  let off = arr.length * WORD;            // 头部占 N 个字
  const heads = items.map((it) => { const h = encUint(off); off += it.length / 2; return h; });
  return encUint(arr.length) + heads.join('') + items.join('');
}

/**
 * abi.encode(string[] a, string[] b)。两个都是动态类型：
 * 外层头部是两个偏移量（相对整段编码的起点），本体依次接在后面。
 */
function encodeStringPair(a, b) {
  const ea = encStringArray(a), eb = encStringArray(b);
  const head = encUint(2 * WORD) + encUint(2 * WORD + ea.length / 2);
  return '0x' + head + ea + eb;
}

/**
 * uint32[]（或任意 uintN[]：每个元素都是一个 32 字节字）。
 * 静态元素的动态数组：长度字后面直接排元素，没有每项偏移。
 */
function encUint32Array(arr) {
  return encUint(arr.length) + arr.map((n) => encUint(n)).join('');
}

/**
 * abi.encode(string[] a, uint32[] b)。两个都是动态类型，头部同样是两个偏移。
 * 干预/造物卡 cardShape=3 的参数指纹走这条：值不再 ToString，而是 unit 空间的 uint32。
 */
function encodeStringUint32Pair(strings, uints) {
  const ea = encStringArray(strings), eb = encUint32Array(uints);
  const head = encUint(2 * WORD) + encUint(2 * WORD + ea.length / 2);
  return '0x' + head + ea + eb;
}

module.exports = {
  keccak256: B.keccak256,
  encUint, encBytes32, encAddress, encodeWords, encString, encStringArray, encodeStringPair,
  encUint32Array, encodeStringUint32Pair, isHex
};
