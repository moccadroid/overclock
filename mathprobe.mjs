// Which Math functions disagree between this Node and this Chrome?
let s = 1;
const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const acc = { sin: 0, cos: 0, atan2: 0, pow: 0, sqrt: 0, exp: 0 };
const bits = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x); return b.getUint32(0) ^ b.getUint32(4); };
for (let i = 0; i < 200000; i++) {
  const a = (next() - 0.5) * 2000;
  const b = (next() - 0.5) * 2000;
  acc.sin = (acc.sin ^ bits(Math.sin(a))) >>> 0;
  acc.cos = (acc.cos ^ bits(Math.cos(a))) >>> 0;
  acc.atan2 = (acc.atan2 ^ bits(Math.atan2(a, b))) >>> 0;
  acc.pow = (acc.pow ^ bits(Math.pow(Math.abs(a) / 1000, 2.9))) >>> 0;
  acc.sqrt = (acc.sqrt ^ bits(Math.sqrt(Math.abs(a)))) >>> 0;
  acc.exp = (acc.exp ^ bits(Math.exp(a / 500))) >>> 0;
}
console.log(JSON.stringify(acc));
console.log('node', process.version);
