// cli/peer.ts
import wrtc from '@roamhq/wrtc';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import WebSocket from 'ws';

const { RTCPeerConnection, RTCDataChannel } = (wrtc as any);

type Role = 'creator' | 'joiner';

export type PeerOpts = {
  name: string;
  role: Role;
  signalingURL: string;
  apiKey?: string; // Optional API key for premium features
  onOpen: () => void;
  onMessage: (text: string) => void;
  onStatus: (text: string) => void;
  onClose: () => void;
  onIce?: (state: string) => void;
  onTickInactivity?: (totalMs: number) => void;
};

const CTRL_PREFIX = '\x00';

const AUTH_URL = process.env.DITCH_AUTH_URL ?? 'https://ditch.chat/auth/turn';
const TURN_HOST = process.env.TURN_HOST ?? 'ditch.chat';

// timeouts
const INACTIVITY_MS = Number(process.env.INACTIVITY_MS || 2 * 60 * 1000);
const WATCH_CONNECT_MS = Number(process.env.WATCH_CONNECT_MS || 12_000);
const JOIN_RETRY_TOTAL_MS = Number(process.env.JOIN_RETRY_TOTAL_MS || 15_000);
const JOIN_RETRY_BASE_MS = Number(process.env.JOIN_RETRY_BASE_MS || 600);

// NEW: watchdog for TURN candidate gathering (avoid instant fail)
const TURN_GATHER_MS = Number(process.env.TURN_GATHER_MS || 3000);

// tiny fetch
function fetchJSON(u: string): Promise<any> {
  return new Promise((res, rej) => {
    const url = new URL(u);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      { method: 'GET', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, headers: { accept: 'application/json' } },
      r => {
        let data = '';
        r.on('data', c => (data += c));
        r.on('end', () => {
          try { res(JSON.parse(data)); } catch (e) { rej(new Error(`Non-JSON auth response: ${data.slice(0, 120)}`)); }
        });
      }
    );
    req.on('error', rej);
    req.end();
  });
}

export class TunnelPeer {
  private pc: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private ws!: WebSocket;
  private opts: PeerOpts;

  private inactivityTimer?: NodeJS.Timeout;
  private disposed = false;
  private wsReconnects = 0;

  private isConnected = false;
  private hasRemoteOffer = false;

  private joinActive = false;
  private joinStart = 0;
  private joinAttempt = 0;
  private joinTimer?: NodeJS.Timeout;

  private connectWatch?: NodeJS.Timeout;
  private iceRestarted = false;

  // NEW: TURN state
  private turnEnabled = false;
  private sawRelayCandidate = false;
  private turnGatherTimer?: NodeJS.Timeout;

  // keepalive (doesn’t bump inactivity)
  private kaTimer?: NodeJS.Timeout;
  private kaTimeout?: NodeJS.Timeout;
  private kaMisses = 0;
  private readonly KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || 10000);
  private readonly KEEPALIVE_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 5000);
  private readonly KEEPALIVE_MISS_MAX = Number(process.env.KEEPALIVE_MISS_MAX || 3);

  constructor(opts: PeerOpts) {
    this.opts = opts;
    // IMPORTANT: start in STUN mode to avoid instant failures
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 8,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.attachPeerHandlers();
    this.connectWS();
  }

  private attachPeerHandlers() {
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.opts.onStatus(`connection: ${s}`);
      this.opts.onIce?.(this.pc.iceConnectionState);

      if (s === 'connected') {
        this.isConnected = true;
        this.stopJoinLoop();
        this.clearWatch();
        this.startKeepalive();
        this.onActivity();
        this.opts.onOpen();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      this.opts.onStatus(`ICE state: ${s}`);
      this.opts.onIce?.(s);
      if (s === 'connected' || s === 'completed') this.onActivity();
    };

    // Trickle ICE + detect relay candidates
    this.pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        // detect relay
        if (typeof ev.candidate.candidate === 'string' && ev.candidate.candidate.includes(' typ relay ')) {
          this.sawRelayCandidate = true;
        }
        this.safeSend({
          type: 'candidate',
          name: this.opts.name,
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
        });
      }
    };

    if (this.opts.role === 'creator') {
      this.dc = this.pc.createDataChannel('tunnel');
      this.wireChannel(this.dc);
    } else {
      this.pc.ondatachannel = (ev: RTCDataChannelEvent) => {
        this.dc = ev.channel;
        this.wireChannel(this.dc);
      };
    }
  }

  private wireChannel(dc: RTCDataChannel) {
    dc.onopen = () => this.opts.onStatus('data channel open');
    dc.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (typeof data === 'string' && data.startsWith(CTRL_PREFIX)) { this.handleControl(data.slice(1)); return; }
      this.onActivity();
      const text = typeof data === 'string' ? data : '[binary]';
      this.opts.onMessage(text);
    };
    dc.onclose = () => this.close();      // keep your existing behavior
    dc.onerror = () => this.opts.onStatus('data channel error');
  }

  private connectWS() {
    if (this.disposed) return;
    this.ws = new WebSocket(this.opts.signalingURL);
    this.ws.on('open', async () => {
      this.wsReconnects = 0;
      // Try TURN upgrade; don't break if it fails
      if (this.opts.apiKey) await this.tryEnableTurn();
      this.startSignaling();
    });
    this.ws.on('message', (raw) => this.onSignal(JSON.parse(raw.toString())));
    this.ws.on('error', (err) => this.opts.onStatus(`signaling error: ${(err as Error).message || err}`));
    this.ws.on('close', () => {
      if (this.disposed || this.isConnected) return;
      const delay = Math.min(2000 + this.wsReconnects * 500, 4000);
      this.wsReconnects++;
      setTimeout(() => this.connectWS(), delay);
    });
  }

  // === TURN enable (safe) ===
  private async tryEnableTurn() {
    // Only try TURN if we have an API key
    if (!this.opts.apiKey) {
      return;
    }

    try {
      const url = new URL(AUTH_URL);
      url.searchParams.set('key', this.opts.apiKey);
      const j = await fetchJSON(url.toString());

      if (!j?.username || !j?.credential) {
        this.opts.onStatus('TURN auth failed (no creds); staying on STUN');
        return;
      }

      (this.pc as any).setConfiguration?.({
        iceServers: [
          { urls: [`turn:${TURN_HOST}:3478?transport=udp`], username: j.username, credential: j.credential },
          { urls: [`turn:${TURN_HOST}:3478?transport=tcp`], username: j.username, credential: j.credential },
          { urls: [`turns:${TURN_HOST}:5349?transport=tcp`], username: j.username, credential: j.credential },
          { urls: ['stun:stun.l.google.com:19302'] }, // keep as last-resort fallback
        ],
        // IMPORTANT: only switch to 'relay' after creds succeed
        iceTransportPolicy: 'relay',
      });
      this.turnEnabled = true;
      this.sawRelayCandidate = false;

      // Start a small watchdog: if no relay candidates are gathered soon, drop back to STUN
      this.turnGatherTimer = setTimeout(() => {
        if (!this.isConnected && !this.sawRelayCandidate) {
          this.opts.onStatus('TURN relay not reachable; falling back to STUN');
          (this.pc as any).setConfiguration?.({
            iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
            iceTransportPolicy: 'all',
          });
          this.turnEnabled = false;
        }
      }, TURN_GATHER_MS);

      this.opts.onStatus('TURN enabled');
    } catch (e) {
      this.opts.onStatus(`TURN auth error; staying on STUN: ${(e as Error).message || e}`);
      // remain on STUN
    }
  }

  // === Offer/Answer (+ trickle) ===
  private async startSignaling() {
    if (this.opts.role === 'creator') {
      const offer = await this.pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await this.pc.setLocalDescription(offer);
      this.safeSend({ type: 'create', name: this.opts.name, sdp: this.pc.localDescription?.sdp });
      this.opts.onStatus(`waiting for a peer to join "${this.opts.name}" …`);
    } else {
      this.startJoinLoop();
    }
  }

  private async onSignal(msg: any) {
    if (msg.type === 'created') return;

    if (msg.type === 'not_found' && this.opts.role === 'joiner') {
      if (this.hasRemoteOffer || this.isConnected) return;
      this.opts.onStatus(`tunnel "${this.opts.name}" not found yet…`);
      return;
    }

    if (msg.type === 'offer' && this.opts.role === 'joiner') {
      this.hasRemoteOffer = true;
      this.stopJoinLoop();
      this.startConnectWatch();

      await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.safeSend({ type: 'answer', name: this.opts.name, sdp: this.pc.localDescription?.sdp });
      this.opts.onStatus('sent answer');
      return;
    }

    if (msg.type === 'answer' && this.opts.role === 'creator') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      this.opts.onStatus('received answer');
      return;
    }

    if (msg.type === 'candidate' && msg.candidate) {
      try {
        await this.pc.addIceCandidate({
          candidate: msg.candidate,
          sdpMid: msg.sdpMid ?? null,
          sdpMLineIndex: msg.sdpMLineIndex ?? null,
        });
      } catch (e) {
        this.opts.onStatus(`addIceCandidate failed: ${(e as Error).message || e}`);
      }
      return;
    }
  }

  private safeSend(obj: any) {
    try {
      if (this.ws && (this.ws as any).readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch { }
  }

  private startJoinLoop() {
    this.stopJoinLoop();
    this.joinActive = true;
    this.joinStart = Date.now();
    this.joinAttempt = 0;

    const tick = () => {
      if (!this.joinActive || this.disposed || this.isConnected || this.hasRemoteOffer) return;
      const elapsed = Date.now() - this.joinStart;
      if (elapsed > JOIN_RETRY_TOTAL_MS) {
        this.safeSend({ type: 'join', name: this.opts.name });
        this.opts.onStatus(`joining "${this.opts.name}" … (last attempt)`);
        this.stopJoinLoop();
        return;
      }
      this.safeSend({ type: 'join', name: this.opts.name });
      const delay = Math.min(JOIN_RETRY_BASE_MS * Math.pow(1.4, this.joinAttempt++), 2000);
      if (!this.hasRemoteOffer && !this.isConnected) {
        this.opts.onStatus(`joining "${this.opts.name}" … (retry in ${Math.ceil(delay / 100) / 10}s)`);
      }
      this.joinTimer = setTimeout(tick, delay);
    };

    this.joinTimer = setTimeout(tick, 0);
  }
  private stopJoinLoop() { this.joinActive = false; if (this.joinTimer) { clearTimeout(this.joinTimer); this.joinTimer = undefined; } }

  private startConnectWatch() {
    this.clearWatch();
    if (this.opts.role !== 'joiner') return;
    this.connectWatch = setTimeout(async () => {
      if (this.isConnected || this.disposed) return;
      if (!this.iceRestarted) {
        this.iceRestarted = true;
        this.opts.onStatus('connection slow, attempting ICE restart…');
        await this.restartIce().catch(() => { });
        this.startConnectWatch();
      }
    }, WATCH_CONNECT_MS);
  }
  private clearWatch() { if (this.connectWatch) { clearTimeout(this.connectWatch); this.connectWatch = undefined; } }

  // keepalive (control frames; no inactivity bump)
  private startKeepalive() {
    this.stopKeepalive();
    if (!this.dc) return;
    const sendPing = () => {
      if (!this.dc || this.dc.readyState !== 'open') return;
      try { this.dc.send(CTRL_PREFIX + 'PING'); } catch { }
      this.kaTimeout = setTimeout(() => {
        this.kaMisses++;
        if (this.kaMisses >= this.KEEPALIVE_MISS_MAX) {
          this.opts.onStatus('peer unresponsive, trying ICE restart…');
          this.restartIce().catch(() => { });
          this.kaMisses = 0;
        }
      }, this.KEEPALIVE_TIMEOUT_MS);
    };
    this.kaTimer = setInterval(sendPing, this.KEEPALIVE_MS);
  }
  private stopKeepalive() { if (this.kaTimer) clearInterval(this.kaTimer); if (this.kaTimeout) clearTimeout(this.kaTimeout); this.kaTimer = undefined; this.kaTimeout = undefined; this.kaMisses = 0; }
  private handleControl(cmd: string) { if (cmd === 'PING') { try { this.dc?.send(CTRL_PREFIX + 'PONG'); } catch { } } else if (cmd === 'PONG') { if (this.kaTimeout) clearTimeout(this.kaTimeout); this.kaTimeout = undefined; this.kaMisses = 0; } }

  private async restartIce() {
    try {
      // keep current config (TURN or STUN)
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      if (this.opts.role === 'creator') {
        this.safeSend({ type: 'create', name: this.opts.name, sdp: this.pc.localDescription?.sdp });
        this.opts.onStatus('reposted offer after ICE restart');
      } else {
        this.safeSend({ type: 'join', name: this.opts.name });
        this.opts.onStatus('requested fresh offer after ICE restart');
      }
    } catch (e) {
      this.opts.onStatus(`ICE restart failed: ${(e as Error).message || e}`);
    }
  }

  send(text: string) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(text);
      this.onActivity();
      return true;
    }
    return false;
  }

  private onActivity() {
    this.opts.onTickInactivity?.(INACTIVITY_MS);
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      this.opts.onStatus('closing due to inactivity');
      this.close();
    }, INACTIVITY_MS);
  }

  close() {
    this.disposed = true;
    if (this.turnGatherTimer) clearTimeout(this.turnGatherTimer);
    this.stopJoinLoop();
    this.stopKeepalive();
    this.clearWatch();
    try { this.dc?.close(); } catch { }
    try { this.pc.close(); } catch { }
    try { this.ws?.close(); } catch { }
    this.opts.onClose();
  }
}
