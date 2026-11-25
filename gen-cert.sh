#!/bin/sh
# Self-signed cert valid for localhost + this Mac's LAN IP. (mkcert is nicer: see README.)
set -e
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
cat > /tmp/blindspot-san.cnf <<EOF2
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=blindspot
[v3]
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$IP
extendedKeyUsage=serverAuth
EOF2
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem -config /tmp/blindspot-san.cnf
echo "Wrote cert.pem/key.pem for localhost and $IP. Run: python3 server.py --cert cert.pem --key key.pem"
