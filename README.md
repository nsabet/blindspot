# Blindspot: optical file transfer (monitor → phone camera)

Offline-capable PWA. **Sender** draws an endless stream of 8-colour frames on a `<canvas>`;
**Receiver** films the screen, recovers the packets, and downloads the file.
Core pipeline (Rust → WebAssembly): Zstd → RaptorQ fountain code → CRC-32 → rate-1/2 K=7 convolutional
code → block interleaver → 3 bits/cell. Receive side: homography → colour calibration → soft-decision Viterbi → CRC → RaptorQ.

> **Status:** written but not yet compiled or tested on hardware. Expect a small compile fix or two
> (see *Troubleshooting → Build errors*) and some real-world tuning.

---

## 1. Prerequisites (macOS, Apple Silicon or Intel)

| Tool | Install | Check |
|---|---|---|
| Xcode Command Line Tools | `xcode-select --install` | `clang --version` |
| Homebrew (optional but handy) | https://brew.sh | `brew --version` |
| Rust toolchain | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` then restart the shell | `rustc --version` |
| Wasm target | `rustup target add wasm32-unknown-unknown` | `rustup target list --installed` |
| wasm-pack | `cargo install wasm-pack` (or `brew install wasm-pack`) | `wasm-pack --version` |
| Python 3 (static server) | ships with macOS / Xcode CLT | `python3 --version` |
| *Optional:* binaryen (`wasm-opt`) | `brew install binaryen` | `wasm-opt --version` |
| *Optional, for phone testing:* cloudflared | `brew install cloudflared` | `cloudflared --version` |

No Node.js, bundler, or C toolchain for zstd is required (Zstd is the pure-Rust `ruzstd` crate).

## 2. Build

```sh
cd blindspot
./build.sh            # = cd core && wasm-pack build --target web --release --out-dir ../web/pkg
```

Output lands in `web/pkg/` (`blindspot_core.js`, `blindspot_core_bg.wasm`). The `web/` folder is the whole app: static files only.

## 3. Run the server

`server.py` (Python 3 stdlib only) serves `web/` **and** the handshake relay. It binds to `0.0.0.0`, so any host on the network can connect.

```sh
python3 server.py                  # http://<your-mac-ip>:8080  (prints all URLs)
python3 server.py --port 9000      # other port;  --host 127.0.0.1 to restrict to this Mac
```

**macOS firewall:** on first run macOS asks *"Do you want the application 'Python' to accept incoming network connections?"* → **Allow**. If you dismissed it: System Settings → Network → Firewall → Options → allow Python (or turn the firewall off while testing). Phone and Mac must be on the same Wi-Fi/LAN (guest/"client isolation" networks block this).

**Phone camera needs HTTPS** (or localhost). Over plain `http://192.168.x.x` the phone browser will refuse `getUserMedia`. Options:

1. **mkcert (recommended):** `brew install mkcert && mkcert -install && mkcert localhost 127.0.0.1 <mac-lan-ip>`, then
   `python3 server.py --cert localhost+2.pem --key localhost+2-key.pem`. Install mkcert's root CA on the phone (`mkcert -CAROOT`; on iOS also enable it under Settings → General → About → Certificate Trust Settings).
2. **Self-signed (quick):** `./gen-cert.sh && python3 server.py --cert cert.pem --key key.pem`. The phone shows a certificate warning: proceed anyway. Camera usually works after that, but the service worker (offline caching) will not register on an untrusted cert.
3. **Tunnel:** `cloudflared tunnel --url http://localhost:8080` gives a trusted `https://*.trycloudflare.com` URL (needs internet; the handshake works through it too).
4. **Static host** (GitHub Pages etc.): works for the optical transfer, but there is no handshake server, so the sender falls back to open-loop mode.

**The URL scheme must match how the server was started.** The startup banner shows `(http)` or `(https)`; use the same scheme on the phone. Typing `https://` against a plain-HTTP server, or `http://` against a TLS server, fails (see Troubleshooting).

Find your Mac's IP with `ipconfig getifaddr en0` (Wi-Fi).

## 3a. Handshake / back-channel

The optical link is one-way (screen → camera). The **return path goes over the network** via `server.py` (Server-Sent Events down, HTTP POST up; no extra packages). The pairing is a 6-character code.

```
Sender                                   Receiver
 pick file → encoder prepared
 shows ALIGNMENT frame (corners+strip)
 shows pairing code ABC123  ───────────►  enter code (or open /?code=ABC123), Start camera
                            ◄── joined
                            ◄── ready      wasm loaded, camera frames flowing
                            ◄── align ok   4 corners + calibration found, stable ~8 frames
 auto-start (or "Start now") ── start ──►
 streams data frames        ◄── progress   ~2 Hz: packets, needed, rate
                            ◄── done       file reconstructed AND download triggered
 stops, shows "receiver confirmed"
```

- If the server is unreachable (static hosting, offline), the sender automatically **falls back to open-loop**: it starts immediately and streams forever; the receiver can still join any time.
- The receiver may leave the code empty to use open-loop mode on purpose.
- The sender's "done" means the receiver reconstructed and verified the file (CRC + RaptorQ + Zstd) and started the browser download. Whether the user saves it is outside the app's knowledge.
- Messages are relayed in memory; sessions expire after 1 hour. Anyone on the LAN who knows the code could join, so treat it as a convenience pairing, not security. The file itself never touches the server.

## 3b. Speed profiles (v2 modem)

Pick a profile on the sender; with a pairing code the receiver adopts it automatically (without a code, pick the same one on the receiver).

| Profile | Grid | Colours/cell | Code rate | Packets/frame | Payload/frame | Ceiling @ 15 fps |
|---|---|---|---|---|---|---|
| classic (v1 baseline) | 64 | 8 (3 bit) | 1/2 | 1 | ~0.5 KB | ~7 KB/s |
| fast | 112 | 64 (6 bit) | 1/2 | 4 | ~4 KB | ~60 KB/s |
| turbo (default) | 128 | 64 (6 bit) | 2/3 | 7 | ~7 KB | ~105 KB/s |
| max | 160 | 64 (6 bit) | 3/4 | 13 | ~13 KB | ~196 KB/s |

"Ceiling" assumes every packet decodes. Real speed = ceiling x packet success rate; the receiver shows measured KB/s. If CRC fails dominate, step down one profile (max -> turbo -> fast -> classic) or lower the fps.

What it needs: camera at 1080p (the status line shows the resolution actually delivered), at least ~5 camera pixels per cell, so fill the camera view with the sender's canvas (tap the canvas for full screen), steady hand or stand, locked exposure where possible, Night Shift/True Tone off. Sender fps must be a divisor of the display refresh and at most half the camera's real frame rate.

Techniques: 4 Gray-coded brightness levels per channel with soft bit confidences; per-frame grey-ramp calibration (measures the camera's response curve per channel, so gamma/exposure drift is absorbed); punctured convolutional code (rate set per profile) with soft Viterbi; several independent packets per frame, one per screen band, so tearing or glare only costs the bands it touches; half-resolution fiducial search.

Troubleshooting additions: "locked" but no packets on fast/turbo/max -> grey-ramp calibration failed or cells too small: step down a profile, move closer, full-screen the sender. "Cannot prepare: file too large" -> single-block limit (~55 MB at 1 KB packets); split the file.

## 4. Using it

1. **Mac:** open the app → *Send File* → choose a file (start with a **small test file, a few KB**). The screen shows a pairing code and an alignment frame.
2. **Phone:** open the sender's join URL (or the app and type the code) → *Receive File* → *Start camera* and grant permission.
3. Point the phone at the screen so **all four white corner squares are visible**, roughly square-on, 20–40 cm for a laptop screen. Hold steady.
4. The status line shows `locked`, packets recovered vs needed, CRC failures, packets/s and ETA. The file downloads automatically when done.
5. The sender starts streaming automatically once the receiver reports it is aligned (untick *auto-start* to use *Start now* instead) and shows live receiver progress; it stops when the receiver confirms completion.

**Mac display settings that matter:** maximum brightness (or at least fixed), turn off **Night Shift** and **True Tone** (they shift white balance mid-transfer), no auto-dim, avoid glare/reflections, keep the browser window visible and in front. Full-screen the tab if the canvas is small. Sender frame rate is selectable (20/24/30); try 20 if the receiver shows many CRC failures.

## 5. Project layout

```
core/src/dsp.rs   CRC-32, conv encoder (133,171 octal), soft Viterbi, interleaver
core/src/lib.rs   wasm-bindgen Encoder / Decoder (packet format, RaptorQ, Zstd container)
web/layout.js     shared grid geometry; must match on both sides
scripts/           build-pages.sh (assemble static site + .nojekyll), publish.sh (gh-pages / userpage)
.github/workflows pages.yml (Actions deploy to Pages)
server.py         static server (0.0.0.0) + handshake relay (SSE/POST)
gen-cert.sh       self-signed cert for LAN HTTPS testing
web/link.js       back-channel client (create/join session, send, receive)
web/sender.js     canvas renderer: alignment frame, then data frames (64x64 cells, integer scaling)
web/receiver.js   camera capture, frame pump to worker, progress/ETA, download
web/rx-worker.js  fiducial detection, homography, calibration strip, soft values, Wasm decode
web/sw.js         cache-first service worker (precaches app + wasm)
```
Packet = 12-byte OTI + 4-byte payload ID + 492-byte symbol + 4-byte CRC = 512 B → 8,204 coded bits → 2,735 cells (the frame offers ~3,360).

## 6. Troubleshooting

### Build errors
| Symptom | Fix |
|---|---|
| `error: can't find crate for 'core'` / target missing | `rustup target add wasm32-unknown-unknown` |
| `wasm-pack: command not found` | `cargo install wasm-pack`; make sure `~/.cargo/bin` is on `PATH` (restart the shell) |
| Compile errors in `ruzstd::encoding::compress_to_vec` or `StreamingDecoder` | `ruzstd` API moved between versions. Check docs.rs for the version in `Cargo.toml` and adjust the two call sites in `lib.rs` (`new` and `finish`). |
| Compile errors on `raptorq` calls (`repair_packets`, `Oti::new`, `get_block_encoders`) | Check docs.rs for raptorq 2.x; signatures are `ObjectTransmissionInformation::new(len, symbol_size, blocks, sub_blocks, alignment)` and `SourceBlockEncoder::repair_packets(start, count)`. |
| `linker`/`clang` errors on Apple Silicon | `xcode-select --install`; `sudo xcode-select --reset` if CLT is stale |
| wasm-pack tries to download `wasm-opt` and fails | Install binaryen (`brew install binaryen`) or add `[package.metadata.wasm-pack.profile.release] wasm-opt = false` to `core/Cargo.toml` |
| Wasm is large/slow | Ensure `--release`; run `wasm-opt -O3` on `web/pkg/*.wasm` |

### Runtime errors
| Symptom | Likely cause / fix |
|---|---|
| Other devices cannot reach the server | macOS firewall blocked Python (section 3); different Wi-Fi/VLAN or client isolation; wrong IP (`ipconfig getifaddr en0`); server started with `--host 127.0.0.1` |
| Server log: `[hint] ... spoke HTTPS to a plain-HTTP server` (older versions: `Bad request version` plus a traceback ending in `'H' object has no attribute 'path'`) | The phone used `https://` but the server was started without `--cert/--key`. Start it with `./gen-cert.sh && python3 server.py --cert cert.pem --key key.pem`, or use `http://` (page loads, but the camera is blocked). Update `server.py` if you still see the traceback |
| Phone: "can't connect" / connection reset on `http://` while the banner says `(https)` | Server is TLS-only; use `https://` and accept the certificate warning |
| Phone: "camera unavailable"/`getUserMedia` undefined on `http://192.168…` | Needs HTTPS; see section 3 |
| "Cannot join: wrong code or server unreachable" | Typo (codes avoid 0/O/1/I), server restarted (sessions are in memory; re-pick the file on the sender), or phone is not on the same network / certificate not trusted for the EventSource request |
| Sender says "No handshake server reachable" | Page was loaded from a static host or file://, or server.py not running; works but without feedback |
| Sender never auto-starts | Receiver not reporting "align ok": check the receiver status line says `locked`; or press *Start now* |
| Sender stuck "Sending…" after the file downloaded | The `done` message could not be posted (network dropped); it retries 4 times and is replayed when the sender reconnects. Check connectivity |
| Blank page, console: failed to fetch `pkg/blindspot_core_bg.wasm` | You haven't run `./build.sh`, or you are serving the wrong directory (serve `web/`) |
| `Incorrect response MIME type` for wasm | Server not sending `application/wasm`; use `python3 -m http.server` (recent) or a proper static host |
| Camera prompt never appears / `getUserMedia` undefined | Not HTTPS/localhost; use a tunnel or host (section 3) |
| Old behaviour after rebuilding | Service worker cache: DevTools → Application → Unregister, hard reload, or bump `C` in `sw.js` |
| iOS: camera works but low frame rate | iOS Safari often caps at 30 fps and ignores the 60 fps hint. It still works; use 20 fps on the sender |

### Transfer problems
| Symptom | Likely cause / fix |
|---|---|
| Stuck on "searching for corners…" | Fewer than 4 corner squares in view, too dark/over-exposed, strong glare, or phone rotated far (>~40°). Reframe, lower screen brightness slightly if blown out, tilt away from reflections |
| `locked` but packets stay at 0, CRC fails climb | Colour decisions wrong or cells too blurry. Disable Night Shift/True Tone, lower sender fps, move closer/hold steadier, wait for camera focus. If cells are under ~5 px in the camera image, reduce `G` in `layout.js` (and packet size `PKT` in `lib.rs` so that `min_cells()` fits) |
| Many CRC failures at a steady rate | Frame tearing / sender-camera beat. Try 20 fps; occasional failures are normal and harmless |
| Progress plateaus just short of 100% | Normal: RaptorQ needs ~K+2 unique packets; keep going, the stream is endless |
| Downloaded file is empty/corrupt | Should not happen (CRC + RaptorQ + Zstd all verify). If it does, re-run with a small file and open an issue with browser/device details |
| Throughput is low (~10 KB/s) | Expected for this first version. Levers: larger grid + packet (needs higher camera resolution), higher fps, better lighting |
| Screen sleeps mid-transfer | Wake Lock is best-effort; on the phone keep the app in the foreground; check iOS Low Power Mode |

## 7. Publish on GitHub Pages (github.io)

GitHub Pages is static HTTPS hosting, so the **camera works** and the service worker gives **offline use after the first load**. There is no handshake server there: the sender detects that and streams open-loop, and the receiver **auto-detects the profile** (leave *Profile* on Auto-detect). All paths are relative, so the same build works at `https://<user>.github.io/` and at `https://<user>.github.io/blindspot/`. `.nojekyll` is generated for you (it stops Pages running Jekyll over the site).

`web/pkg/` is git-ignored build output, so deployment must build the Wasm. Pick one route:

**A. GitHub Actions (recommended; nothing built is committed)**
1. Create a repo (e.g. `blindspot`), commit everything including `core/Cargo.lock`, push to `main`.
2. Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
3. `.github/workflows/pages.yml` builds with `scripts/build-pages.sh` and deploys on every push. URL: `https://<user>.github.io/blindspot/`. (Action versions in the workflow were current when written; bump them if GitHub warns.)

**B. Build locally and push a `gh-pages` branch**
```sh
scripts/publish.sh gh-pages          # builds, then force-pushes dist/ to origin/gh-pages
```
Then Settings → Pages → Source: *Deploy from a branch* → `gh-pages` / `(root)`.

**C. Add it to your existing personal site (`<user>.github.io` repo) under `/blindspot/`**
```sh
scripts/publish.sh userpage ../<user>.github.io    # builds, copies into <repo>/blindspot/, commits
cd ../<user>.github.io && git push
```
Do **not** add a root `.nojekyll` to that repo unless your site doesn't use Jekyll; the Blindspot files don't need it there (no leading-underscore names).

**D. Deploy from `/docs` on main:** `scripts/build-pages.sh docs`, commit `docs/`, Settings → Pages → *Deploy from a branch* → `main` / `/docs`.

Notes: each build stamps a fresh service-worker cache name, so returning users pick up new versions on reload (close and reopen the PWA once). If you change the repo name or URL nothing needs editing. Pages serves `.wasm` as `application/wasm` automatically.

## 8. Known limitations
- The back-channel needs the LAN server; a fully air-gapped pair of devices has no feedback path and uses open-loop mode.
- Fiducial detection is simple (bright squarish blobs; top/bottom split by y) and fails under large rotation or heavy glare.
- Only the fastest Zstd level is available in `ruzstd`, so compression ratio is modest.
- No icons in the manifest yet (installable on Android needs a 192/512 px icon; add to `web/` and `manifest.webmanifest`).
- Colour crosstalk is handled by per-channel levels from the 8-patch strip, not a full 3×3 colour matrix.
