#!/bin/sh
# Local dev build. Needs: rustup target add wasm32-unknown-unknown ; cargo install wasm-pack
cd "$(dirname "$0")/core" && wasm-pack build --target web --release --out-dir ../web/pkg
# then, from the project root:  python3 server.py
