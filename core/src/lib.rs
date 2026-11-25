mod dsp;
use dsp::*;
use raptorq::{Decoder as RqDec, Encoder as RqEnc, EncodingPacket, ObjectTransmissionInformation as Oti};
use std::collections::HashSet;
use std::io::Read;
use wasm_bindgen::prelude::*;

// Profile: bits per cell (3 = 8 colours, 6 = 4 levels/channel Gray-coded), code rate (0=1/2, 1=2/3, 2=3/4), packet bytes.
// Packet = OTI(12) | RaptorQ payload id(4) + symbol | CRC32(4). A frame carries several independent packets (spatial bands).
#[derive(Clone, Copy)]
struct Prof { bpc: usize, rate: u8, pkt: usize }
impl Prof {
    fn mother(&self) -> usize { 2 * (self.pkt * 8 + 6) }
    fn tx_bits(&self) -> usize { punctured_len(self.mother(), self.rate) }
    fn cells(&self) -> usize { (self.tx_bits() + self.bpc - 1) / self.bpc }
    fn sym(&self) -> usize { self.pkt - 20 }
}
fn prof(bpc: usize, rate: u8, pkt: usize) -> Result<Prof, JsError> {
    if !(1..=8).contains(&bpc) || rate > 2 || !(64..=4096).contains(&pkt) { return Err(JsError::new("bad profile")); }
    Ok(Prof { bpc, rate, pkt })
}

#[wasm_bindgen]
pub struct Encoder { rq: RqEnc, src: Vec<Vec<u8>>, oti: [u8; 12], k: u32, p: Prof, perm: Vec<usize> }

#[wasm_bindgen]
impl Encoder {
    #[wasm_bindgen(constructor)]
    pub fn new(file: &[u8], name: &str, bpc: usize, rate: u8, pkt: usize) -> Result<Encoder, JsError> {
        let p = prof(bpc, rate, pkt)?;
        let nb = &name.as_bytes()[..name.len().min(65535)];
        let mut c = Vec::with_capacity(file.len() + nb.len() + 2);
        c.extend_from_slice(&(nb.len() as u16).to_le_bytes()); c.extend_from_slice(nb); c.extend_from_slice(file);
        let z = ruzstd::encoding::compress_to_vec(&c[..], ruzstd::encoding::CompressionLevel::Fastest);
        if z.len() > 56_000 * p.sym() { return Err(JsError::new("file too large for one RaptorQ source block (~55 MB at this packet size)")); }
        let rq = RqEnc::new(&z, Oti::new(z.len() as u64, p.sym() as u16, 1, 1, 1));
        let src = rq.get_block_encoders().iter().flat_map(|b| b.source_packets()).map(|q| q.serialize()).collect();
        let oti = rq.get_config().serialize();
        Ok(Encoder { rq, src, oti, k: 0, p, perm: interleave_order(p.tx_bits()) })
    }
    pub fn cells_per_packet(&self) -> usize { self.p.cells() }
    pub fn sym_bytes(&self) -> usize { self.p.sym() }
    pub fn source_packets(&self) -> usize { self.src.len() }
    pub fn packet_index(&self) -> u32 { self.k }

    /// Next packet as `cells_per_packet()` cell values of `bpc` bits each (MSB first). Endless stream.
    pub fn next_packet(&mut self) -> Vec<u8> {
        let k = self.k as usize; self.k += 1;
        let q = if k < self.src.len() { self.src[k].clone() } else {
            let r = k - self.src.len(); let bl = self.rq.get_block_encoders();
            bl[r % bl.len()].repair_packets((r / bl.len()) as u32, 1)[0].serialize()
        };
        let mut pkt = Vec::with_capacity(self.p.pkt);
        pkt.extend_from_slice(&self.oti); pkt.extend_from_slice(&q);
        let crc = crc32(&pkt); pkt.extend_from_slice(&crc.to_le_bytes());
        let coded = puncture(&conv_encode(&bytes_to_bits(&pkt)), self.p.rate);
        let mut tx = vec![0u8; self.p.cells() * self.p.bpc];
        for (j, &i) in self.perm.iter().enumerate() { tx[j] = coded[i]; }
        let mut lf = 0xACE1u16;
        for b in tx[self.p.tx_bits()..].iter_mut() { lf = (lf >> 1) ^ (0u16.wrapping_sub(lf & 1) & 0xB400); *b = (lf & 1) as u8; }
        tx.chunks(self.p.bpc).map(|c| c.iter().fold(0u8, |a, &b| (a << 1) | b)).collect()
    }
}

#[wasm_bindgen]
pub struct Decoder {
    p: Prof, perm: Vec<usize>, rq: Option<RqDec>, k: u32, seen: HashSet<u32>,
    bad: u32, name: String, out: Vec<u8>, done: bool,
}

#[wasm_bindgen]
impl Decoder {
    #[wasm_bindgen(constructor)]
    pub fn new(bpc: usize, rate: u8, pkt: usize) -> Result<Decoder, JsError> {
        let p = prof(bpc, rate, pkt)?;
        Ok(Decoder { p, perm: interleave_order(p.tx_bits()), rq: None, k: 0, seen: HashSet::new(), bad: 0, name: String::new(), out: vec![], done: false })
    }
    pub fn cells_per_packet(&self) -> usize { self.p.cells() }
    /// soft: `bpc` values per cell in [-1,1] (>0 = bit 1), same bit order as the encoder. 0 = bad CRC, 1 = packet ok, 2 = file complete.
    pub fn push_packet(&mut self, soft: &[f32]) -> u8 {
        let n = self.p.tx_bits();
        if self.done { return 2; }
        if soft.len() < n { return 0; }
        let mut s = vec![0f32; n];
        for (j, &i) in self.perm.iter().enumerate() { s[i] = soft[j]; }
        let bytes = bits_to_bytes(&viterbi(&depuncture(&s, self.p.rate, self.p.mother())));
        if bytes.len() != self.p.pkt { return 0; }
        let (body, tail) = bytes.split_at(self.p.pkt - 4);
        if crc32(body) != u32::from_le_bytes(tail.try_into().unwrap()) { self.bad += 1; return 0; }
        let id = u32::from_be_bytes(body[12..16].try_into().unwrap());
        if !self.seen.insert(id) { return 1; }
        if self.rq.is_none() {
            let oti = Oti::deserialize(body[..12].try_into().unwrap());
            let ss = oti.symbol_size() as u64;
            self.k = ((oti.transfer_length() + ss - 1) / ss) as u32;
            self.rq = Some(RqDec::new(oti));
        }
        if let Some(z) = self.rq.as_mut().unwrap().decode(EncodingPacket::deserialize(&body[12..])) { self.finish(&z); }
        if self.done { 2 } else { 1 }
    }
    fn finish(&mut self, z: &[u8]) {
        let mut c = Vec::new();
        if let Ok(mut d) = ruzstd::decoding::StreamingDecoder::new(z) {
            if d.read_to_end(&mut c).is_ok() && c.len() >= 2 {
                let n = u16::from_le_bytes([c[0], c[1]]) as usize;
                if c.len() >= 2 + n {
                    self.name = String::from_utf8_lossy(&c[2..2 + n]).into();
                    self.out = c[2 + n..].to_vec(); self.done = true;
                }
            }
        }
    }
    pub fn good(&self) -> u32 { self.seen.len() as u32 }
    pub fn bad(&self) -> u32 { self.bad }
    pub fn needed(&self) -> u32 { self.k }
    pub fn done(&self) -> bool { self.done }
    pub fn file_name(&self) -> String { self.name.clone() }
    pub fn file_data(&self) -> Vec<u8> { self.out.clone() }
}
