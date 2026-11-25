// Back-channel to the peer via the server (SSE down, POST up). The optical channel stays one-way.
export class Link {
  constructor() { this.es = null; this.id = null; this.role = null; this.onmsg = () => {}; }
  async create() {
    const r = await fetch('/api/session', { method: 'POST' });
    if (!r.ok) throw new Error('no handshake server');
    this.id = (await r.json()).id; this.role = 'sender'; await this._open(); return this.id;
  }
  async join(id) { this.id = id.trim().toUpperCase(); this.role = 'receiver'; await this._open(); }
  _open() {
    return new Promise((res, rej) => {
      const es = this.es = new EventSource(`/api/events?s=${this.id}&role=${this.role}`);
      es.onopen = () => res();
      es.onmessage = e => { try { this.onmsg(JSON.parse(e.data)); } catch {} };
      es.onerror = () => { if (es.readyState === EventSource.CLOSED) rej(new Error('link closed')); }; // auto-reconnects otherwise
    });
  }
  async send(m) {
    if (!this.id) return;
    for (let i = 0; i < 4; i++) {
      try { const r = await fetch(`/api/msg?s=${this.id}&from=${this.role}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) }); if (r.ok) return; } catch {}
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  close() { this.es?.close(); }
}
