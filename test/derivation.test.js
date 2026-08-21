/*
 * 推导链测试：哈希 → 参数 → 结局 → cardHash，以及 ops 的编解码与复算
 * 运行：node test/derivation.test.js
 *
 * 金标准来自链上：BSC 测试网现役 MirrorUniverse（0xf8b2…7740，chainId 97）
 * 2026-08-22 读出来的 12 枚 token 的 cardOf / outcome / rarity，
 * 其中 #12 被拯救过一次（intervene 交易 0xac49e7d5…，ops = 0x1413ec3c92）。
 * 这些值是 ethers 的 AbiCoder 编出来、服务端签了名、合约收下的 —— 本仓库零依赖的
 * ABI 编码器和引擎要是差一个字节，这里就红。
 */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'lib', 'index.js'));
const B = L.bnbhash, P = L.params, ABI = L.abi;

let passed = 0, failed = 0; const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + (a === b ? '' : '（得到 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）')); }
function throws(fn, re, msg) {
  let m = null; try { fn(); } catch (e) { m = e.message; }
  ok(m != null && (!re || re.test(m)), msg + (m == null ? '（没有抛错）' : (re && !re.test(m) ? '（抛的是：' + m + '）' : '')));
}
function section(t) { console.log('\n== ' + t); }

/* ---------------------------------------------------------------- 金标准（链上） */
const CHAIN = [
  // tokenId, blockHash, blockNumber, outcome, rarity, cardOf
  [1, '0xca00b6c467818ea0fafdc417f9cb902ea9db297e1ef0ad3961997f621adfce4c', 60991179, 9, 0, '0xf0519ad4ab2556955f9aedb6527f98739f4e1ba090eecb0d3f5686edf79d240a'],
  [2, '0x52765cbb8c8d05c7be3442abc4d3e56df7164f12d1aa003b075205dc8007211b', 32623653, 0, 2, '0x58d64d016617acb740c7eeca90271316f6e356bd7f2a5ec10d74a3b59c33b928'],
  [3, '0x0dd3cc2535182fb254268fd63a85ea9d5806ca2afc489878b62eb916fa7cb0a7', 12660736, 0, 4, '0x7a56153914343efc0aab15038bd33053d8d3912b2becbe9dcc66118a4b36b5fd'],
  [4, '0x97645c0f4ccce40d14f0376d84053017170b8dea1dd956b9fc4a903b542d1600', 88871525, 0, 2, '0xffa614b7759a842b559223351c7cc3587c7083662c63208d837ce640bf121feb'],
  [5, '0x83ad8947ae7844350d4aaea730106424f0c154bda2acb93af015828c0f1b82f6', 123583435, 0, 2, '0x47911f16e339f1aa145b4508ad564586f560ab04bf83fc4ba7b3501667c31895'],
  [6, '0x5d503ce79ea466831b9ad720ea0586423c23522bbb2bbc36f1526b39874278e8', 110009867, 9, 0, '0xf9ea5cae2a799336661797b7e1d5fccfaed99c03af858fdae1e981b942ffa4b3'],
  [7, '0xbab97c8a737eaca34ec6e34c3ada91665579b5e47d40f6bf4a6698cd818d93e5', 9401569, 0, 2, '0xb975e996fb7e336bfa47ca287ffd9484d319fef43ef02869770874ffd81f8d4c'],
  [8, '0x011179c10baa83489b84b091087144e4e52c6059cb3240dcab55d87ad74b9ddf', 93232628, 0, 2, '0xbcb7e85bac7289078309e27dbfbb83ff9ee865100a6f6507efb0924759272983'],
  [9, '0xdf02bbe62126ad282f94538cb632c2d538a995ad3d0f84c3f1ec8cd295299e2b', 46177495, 0, 2, '0xb30df46001afa0a55d62a80dbcc7944b89cc94dd388c4680fc26c55e9ae1f9ca'],
  [10, '0x3a5a2bac329d25578d93bcdd37283c1f1c52bb4c44a6742d597b29dc5265a255', 22557967, 0, 2, '0x81dcab97c6a558a584d0bb4167e0e91b83b81938d9aca16a3aacdda99e21958c'],
  [11, '0x5abdbfdaa513a361c6b1cf3bf9b3f833942d2dd05a0df04548852930e0c9cea3', 73000799, 0, 4, '0x693a04b7f8bb20b7607077d68b28a157c0e48737de46812892fa906356fea640']
];
/* #12：原生是 UNSTABLE_ORBITS / B；一笔 intervene 把 stringGasT（下标 20）推到 unit 0.334249106 后救活成 S */
const T12 = {
  blockHash: '0xaba6326260aa71fbfa0ebae354ef3ac62f40c0486c7dbd596df8b4aa8594afb2',
  nativeCardHash: '0x59bd8e1c2080f8e4b2020486fa0d1e48cbae8466585193642696d6c48c910315',
  nativeOutcome: 0, nativeRarity: 2,
  ops: '0x1413ec3c92',
  opsHash: '0x12c634fe761c5b61ad75a44ae7855d90d6489372bd44727312ae4d77a635e644',
  cardOf: '0xf5f46edc172b2888e6793443f9e8dcaef6b5d448305a2ddf6a5c8ce24da6a072',
  outcome: 9, rarity: 0
};

/* ---------------------------------------------------------------- */
section('keccak256 与派生自检');
const st = B.selfTest();
ok(st.ok, 'bnbhash.selfTest：keccak 向量 + 派生确定性' + (st.ok ? '' : '：' + st.fails.join('；')));
eq(B.keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256("") 标准向量');
eq(B.keccak256('0x'), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'keccak256(0x) = 空字节串');
eq(B.keccak256('signer()').slice(0, 10), '0x238ac933', '函数选择器 signer() = 0x238ac933（与部署文档一致）');
eq(B.keccak256('intervene(uint256,bytes32,uint8,uint8,uint256,uint64,bytes,bytes)').slice(0, 10), '0x83de78df', '选择器 intervene(...) = 0x83de78df');

section('派生：槽位与档位');
const h1 = CHAIN[0][1];
const d = B.derive(h1);
eq(d.uInt.length, 22, 'uInt 有 22 个槽（gNewton 不占槽，走专用槽 200）');
ok(d.uInt.every((n) => Number.isInteger(n) && n >= 0 && n < B.U_DEN), '每个槽是 [0, 1e9) 的整数');
ok(d.u.every((x, i) => x === d.uInt[i] / B.U_DEN), 'u = uInt / 1e9');
eq(Object.keys(d.params).length, 23, '参数 23 个（19 基础 + gNewton + 3 弦气，dimS 被派生掉）');
ok(B.PARAM_KEYS.indexOf('dimS') < 0 && B.PARAM_KEYS.indexOf('gNewton') >= 0, 'PARAM_KEYS 无 dimS、有 gNewton');
ok(['uG', 'uF1', 'uF2'].every((k) => Number.isInteger(d.frame[k]) && d.frame[k] >= 0 && d.frame[k] < B.U_DEN), '三个专用槽是 [0, 1e9) 的整数');
// slot 的定义：keccak256(hash ‖ uint8(i)) mod m —— 与 Solidity uOf() 同式
const manual = (i, m) => Number(BigInt(B.keccak256(h1 + i.toString(16).padStart(2, '0'))) % BigInt(m));
ok([0, 1, 7, 21].every((i) => B.slot(h1, i, B.U_DEN) === manual(i, B.U_DEN)), 'slot(h,i) = uint256(keccak256(h ‖ uint8(i))) mod 1e9');
eq(B.slot(h1, 255, 1000), manual(255, 1000), '档位槽 255 mod 1000');
eq(d.tier.id, 'whisper', '#1 的档位是 whisper（slot255 < 500）');
ok(JSON.stringify(B.derive(h1)) === JSON.stringify(d), '同一哈希两次派生逐位相同');
ok(JSON.stringify(B.derive(h1.toUpperCase().replace('0X', '0x'))) === JSON.stringify(d), '哈希大小写不影响派生');
throws(() => B.derive('0x1234'), /32 字节/, '短哈希被拒');
throws(() => B.derive(h1 + '00'), /32 字节/, '长哈希被拒');

section('ABI 编码（零依赖）与 ethers 的输出一致');
eq(ABI.keccak256(ABI.encodeStringPair(['a', 'bb'], ['x', 'yy'])), '0x464fff4aca30dc0c7ed448a9d745d84b40ad34e13e5ca072606de4127737b04d',
  'keccak256(abi.encode(string[] ["a","bb"], string[] ["x","yy"])) = ethers');
eq(ABI.encodeStringPair(['a', 'bb'], ['x', 'yy']).length, 2 + 64 * 16, '……编码长 16 个字（2 个外层偏移 + 2×(1 长度 + 2 偏移 + 2 个字符串各 2 字)）');
eq(ABI.keccak256(ABI.encodeStringPair(['alpha', 'omegaLambda', '这是中文'], ['0.007297352569311', '6.9e-10', '1e+21'])),
  '0x6019e17df85dfeeb36fe8d049db08444d6d70315e6278ded53e8a341d5de4a1a', '含 UTF-8 多字节与科学计数法字符串的指纹 = ethers');
eq(ABI.keccak256(ABI.encodeStringPair([], [])), '0xc6df19a9e5cc2e1575f8bc5ee97cc5b352e49114c858bb010d9874784ccd5fc7', '空数组对 = ethers');
eq(ABI.encUint(255), '00000000000000000000000000000000000000000000000000000000000000ff', 'uint 左补零到 32 字节');
throws(() => ABI.encUint(-1), /越界/, '负数被拒');
throws(() => ABI.encBytes32('0x12'), /bytes32/, '非 32 字节被拒');

section('原生卡：12 枚链上 token 的 cardHash / outcome / rarity');
eq(L.DERIVATION_VERSION, 3, 'DERIVATION_VERSION = 3');
eq(L.CARD_SHAPE, 2, 'CARD_SHAPE = 2');
CHAIN.forEach(([id, hash, num, outcome, rarity, cardOf]) => {
  const { card, cardHash } = L.buildCard(hash, num);
  ok(cardHash === cardOf && card.outcome.index === outcome && card.rarity.index === rarity,
    '#' + id + ' ' + hash.slice(0, 10) + '… → ' + L.OUTCOME_ORDER[outcome] + '/' + L.RARITY_NAME[rarity] + ' ' + cardOf.slice(0, 12) + '…'
    + (cardHash === cardOf ? '' : '（算得 ' + cardHash + '）'));
});
{
  const a = L.buildCard(h1, 1), b = L.buildCard(h1, 999999), c = L.buildCard(h1, null);
  ok(a.cardHash === b.cardHash && b.cardHash === c.cardHash, 'cardHash 与 blockNumber 无关');
  eq(a.card.blockNumber, 1, 'blockNumber 只是记录');
  eq(c.card.blockNumber, null, '不给 blockNumber 时记 null');
  ok(a.card.uInt.length === 22 && a.card.frameSlots.uG === d.frame.uG, 'card 带出 uInt[22] 与三个专用槽');
  eq(a.card.derivationVersion, 3, 'card.derivationVersion = 3');
  eq(a.card.engineVersion, L.engine.VERSION || a.card.engineVersion, 'card.engineVersion 来自引擎');
  // 手算一遍 cardHash 的算式
  const words = [ABI.encBytes32(h1)].concat(d.uInt.map(ABI.encUint))
    .concat([d.frame.uG, d.frame.uF1, d.frame.uF2, a.card.outcome.index, a.card.rarity.index, 3].map(ABI.encUint));
  eq(ABI.keccak256('0x' + words.join('')), a.cardHash, 'cardHash = keccak256(bytes32 ‖ uint32[22] ‖ uG ‖ uF1 ‖ uF2 ‖ outcome ‖ rarity ‖ version)');
  eq(words.length, 29, '编码恰好 29 个字');
}

section('稀有度表');
eq(L.rarityOf('OBSERVERS_POSSIBLE', 3), 0, 'S：能诞生观察者');
eq(L.rarityOf('OBSERVERS_POSSIBLE', 2.5), 0, 'S 不看维度');
eq(L.rarityOf('NO_STARS', 3), 1, 'A：三维但没活');
eq(L.rarityOf('NO_STARS', 4), 2, 'B：整数维非三维');
eq(L.rarityOf('NO_STARS', 2.5), 3, 'C：半整数维');
eq(L.rarityOf('NO_STARS', 1), 4, 'D：一维及以下');
eq(L.rarityOf('NO_STARS', null), 4, 'D：维度缺失');
eq(L.RARITY_NAME.join(''), 'SABCD', 'RARITY_NAME = S A B C D');
eq(L.OUTCOME_ORDER.length, 12, '12 种结局');
eq(L.OUTCOME_ORDER[9], 'OBSERVERS_POSSIBLE', '结局 #9 = OBSERVERS_POSSIBLE（合约 intervene 里写死的 9）');

section('ops：编解码');
eq(L.PARAM_KEYS.length, 23, 'ops 下标表 23 个');
eq(L.PARAM_KEYS[20], 'stringGasT', '下标 20 = stringGasT（#12 那笔 ops 推的就是它）');
eq(L.OPS_SCALE, 1e9, 'OPS_SCALE = 1e9（与合约 U_DEN 同刻度）');
{
  const dec = L.decodeOps(T12.ops);
  ok(dec.length === 1 && dec[0].index === 20 && dec[0].key === 'stringGasT' && dec[0].unitInt === 334249106 && dec[0].unit === 0.334249106,
    '链上 ops 0x1413ec3c92 → [stringGasT @ 334249106/1e9]');
  eq(L.encodeOps(dec), T12.ops, '解码再编码回到原样');
  eq(L.opsHashOf(T12.ops), T12.opsHash, 'opsHash = keccak256(ops 原始字节)');
  eq(L.opsHashOf('1413ec3c92'), T12.opsHash, '不带 0x 也认');
}
{
  const src = [{ key: L.PARAM_KEYS[2], unitInt: 0 }, { key: L.PARAM_KEYS[0], unitInt: L.OPS_SCALE }];
  const dd = L.decodeOps(L.encodeOps(src));
  ok(dd.length === 2 && dd[0].index === 0 && dd[0].unitInt === L.OPS_SCALE && dd[1].index === 2 && dd[1].unitInt === 0, '编码按下标升序重排');
}
throws(() => L.decodeOps('0x'), /空/, '空 ops 被拒');
throws(() => L.decodeOps('0x1413ec3c'), /整数倍/, '长度不是 5 的倍数被拒');
throws(() => L.decodeOps('0xff00000000'), /不存在/, '下标越界被拒');
throws(() => L.decodeOps('0x0100000000' + '0000000000'), /升序/, '下标乱序被拒');
throws(() => L.decodeOps('0x0100000000' + '0100000000'), /升序/, '下标重复被拒');
throws(() => L.decodeOps('0x00ffffffff'), /超过/, '刻度超过 1e9 被拒');
throws(() => L.decodeOps('0xzz'), /十六进制/, '非十六进制被拒');
throws(() => L.encodeOps([{ key: 'nope', unitInt: 1 }]), /越界/, '未知参数名被拒');
throws(() => L.encodeOps([{ index: 0, unitInt: 1 }, { index: 0, unitInt: 2 }]), /两次/, '重复下标被拒');
ok([0, 0.5, 1, 0.334249106, 1e-10, 2, -1].every((u) => L.unquantize(L.quantizeUnit(u)) === Math.min(1, Math.max(0, Math.round(Math.min(1, Math.max(0, u)) * 1e9) / 1e9))), 'quantize/unquantize 夹在 [0,1] 且互逆');

section('干预卡：只用 blockHash + ops 复算 #12');
{
  const nat = L.buildCard(T12.blockHash, null);
  ok(nat.cardHash === T12.nativeCardHash && nat.card.outcome.index === T12.nativeOutcome && nat.card.rarity.index === T12.nativeRarity,
    '#12 原生：' + L.OUTCOME_ORDER[T12.nativeOutcome] + '/' + L.RARITY_NAME[T12.nativeRarity] + ' ' + T12.nativeCardHash.slice(0, 12) + '…');
  const r = L.recomputeWithOps(T12.blockHash, T12.ops);
  eq(r.cardHash, T12.cardOf, '★ 复算 cardHash = 链上 cardOf(12)');
  ok(r.card.outcome.index === T12.outcome && r.card.rarity.index === T12.rarity, '复算结局 #9 OBSERVERS_POSSIBLE、稀有度 S，与链上一致');
  eq(r.opsHash, T12.opsHash, 'opsHash 一致');
  ok(r.card.intervention.rescued === true && r.card.intervention.from.outcome === 'UNSTABLE_ORBITS', '标记为"从 UNSTABLE_ORBITS 救活"');
  ok(r.card.intervention.moved.length === 1 && r.card.intervention.moved[0].key === 'stringGasT', '只动了 stringGasT');
  ok(r.card.params.stringGasT === P.fromUnit('stringGasT', 0.334249106), '干预后的 stringGasT = fromUnit(0.334249106)');
  ok(Object.keys(r.card.params).every((k) => k === 'stringGasT' || r.card.params[k] === nat.card.params[k]), '其余参数与原生逐位相同');
  // 算式
  const keys = Object.keys(r.card.params).sort();
  const fp = ABI.keccak256(ABI.encodeStringPair(keys, keys.map((k) => String(r.card.params[k]))));
  eq(ABI.keccak256(ABI.encodeWords([ABI.encBytes32(T12.blockHash), ABI.encBytes32(fp), ABI.encUint(9), ABI.encUint(0), ABI.encUint(3)])), r.cardHash,
    'cardHash = keccak256(blockHash ‖ keccak256(abi.encode(keys[], values[])) ‖ outcome ‖ rarity ‖ version)');
  eq(L.cardHashOf(T12.blockHash, r.card.params, 9, 0), r.cardHash, 'cardHashOf 与 recomputeWithOps 同一份实现');
  // 改一个刻度就是另一个宇宙
  const alt = L.recomputeWithOps(T12.blockHash, '0x1413ec3c91');
  ok(alt.cardHash !== r.cardHash, 'ops 改一个刻度 → 另一个 cardHash');
  // 与 applyOpsHex 的等价
  ok(JSON.stringify(L.applyOpsHex(nat.card.params, T12.ops)) === JSON.stringify(r.card.params), 'applyOpsHex 给出同一份参数');
}

section('确定性');
{
  const a = L.buildCard(CHAIN[5][1], null), b = L.buildCard(CHAIN[5][1], null);
  ok(JSON.stringify(a) === JSON.stringify(b), '同一哈希两次 buildCard 逐位相同（含浮点参数与常数）');
  const x = L.recomputeWithOps(T12.blockHash, T12.ops), y = L.recomputeWithOps(T12.blockHash, T12.ops);
  ok(JSON.stringify(x) === JSON.stringify(y), '同一 (哈希, ops) 两次复算逐位相同');
}

console.log('\n' + passed + ' 通过，' + failed + ' 失败');
if (failed) { console.log('失败项：\n - ' + failures.join('\n - ')); process.exit(1); }
