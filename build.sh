#!/bin/sh
# needs: rustup target add wasm32-unknown-unknown ; cargo install wasm-pack
cd core && wasm-pack build --target web --release --out-dir ../web/pkg
# then, from the project root:  python3 server.py
