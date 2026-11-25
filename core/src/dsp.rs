// CRC-32, rate-1/2 K=7 convolutional code (133,171 octal), soft Viterbi, block interleaver.
pub fn crc32(d: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in d {
        c ^= b as u32;
        for _ in 0..8 { c = (c >> 1) ^ (0xEDB8_8320 & (c & 1).wrapping_neg()); }
    }
    !c
}
const G0: usize = 0o133;
const G1: usize = 0o171;
#[inline] fn par(x: usize) -> u8 { (x.count_ones() & 1) as u8 }

pub fn bytes_to_bits(b: &[u8]) -> Vec<u8> {
    b.iter().flat_map(|&x| (0..8).rev().map(move |i| (x >> i) & 1)).collect()
}
pub fn bits_to_bytes(b: &[u8]) -> Vec<u8> {
    b.chunks(8).map(|c| c.iter().fold(0u8, |a, &x| (a << 1) | x)).collect()
}
/// Encode bits + 6 zero tail bits -> 2*(n+6) coded bits.
pub fn conv_encode(bits: &[u8]) -> Vec<u8> {
    let mut s = 0usize;
    let mut out = Vec::with_capacity(2 * (bits.len() + 6));
    for &u in bits.iter().chain([0u8; 6].iter()) {
        let reg = ((u as usize) << 6) | s;
        out.push(par(reg & G0));
        out.push(par(reg & G1));
        s = reg >> 1;
    }
    out
}
/// Soft Viterbi. soft[i] in [-1,1]: >0 means coded bit 1, magnitude = confidence.
/// Maximises correlation metric. Returns the info bits (tail stripped).
pub fn viterbi(soft: &[f32]) -> Vec<u8> {
    let steps = soft.len() / 2;
    let neg = f32::NEG_INFINITY;
    let mut pm = [neg; 64];
    pm[0] = 0.0;
    let mut dec = vec![0u64; steps];
    for t in 0..steps {
        let (a, b) = (soft[2 * t], soft[2 * t + 1]);
        let mut np = [neg; 64];
        let mut d = 0u64;
        for s in 0..64usize {
            if pm[s] == neg { continue; }
            for u in 0..2usize {
                let reg = (u << 6) | s;
                let ns = reg >> 1;
                let m = pm[s] + if par(reg & G0) == 1 { a } else { -a } + if par(reg & G1) == 1 { b } else { -b };
                if m > np[ns] {
                    np[ns] = m;
                    d = (d & !(1u64 << ns)) | (((s & 1) as u64) << ns); // dropped LSB identifies predecessor
                }
            }
        }
        dec[t] = d;
        pm = np;
    }
    let mut bits = vec![0u8; steps];
    let mut ns = 0usize; // terminated in state 0
    for t in (0..steps).rev() {
        bits[t] = (ns >> 5) as u8;
        ns = ((ns << 1) & 0x3F) | ((dec[t] >> ns) & 1) as usize;
    }
    bits.truncate(steps.saturating_sub(6));
    bits
}
/// Block interleaver: write row-wise, read column-wise. order[j] = source index of tx bit j.
pub fn interleave_order(len: usize) -> Vec<usize> {
    const R: usize = 32;
    let c = (len + R - 1) / R;
    let mut o = Vec::with_capacity(len);
    for col in 0..c { for row in 0..R { let i = row * c + col; if i < len { o.push(i); } } }
    o
}

/// Puncturing patterns over the mother-code stream A0 B0 A1 B1 ...: 0 = 1/2, 1 = 2/3, 2 = 3/4 (standard patterns for 133/171).
fn pat(rate: u8) -> &'static [u8] { match rate { 1 => &[1, 1, 0, 1], 2 => &[1, 1, 0, 1, 1, 0], _ => &[1] } }
pub fn punctured_len(n: usize, r: u8) -> usize { let p = pat(r); (0..n).filter(|i| p[i % p.len()] == 1).count() }
pub fn puncture(c: &[u8], r: u8) -> Vec<u8> {
    let p = pat(r); c.iter().enumerate().filter(|(i, _)| p[i % p.len()] == 1).map(|(_, &b)| b).collect()
}
/// Re-insert erasures (soft = 0) where bits were punctured.
pub fn depuncture(s: &[f32], r: u8, n: usize) -> Vec<f32> {
    let p = pat(r); let mut o = vec![0f32; n]; let mut j = 0;
    for i in 0..n { if p[i % p.len()] == 1 { if j < s.len() { o[i] = s[j]; } j += 1; } }
    o
}
