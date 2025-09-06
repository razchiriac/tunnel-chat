// cli/peer.ts
import wrtc from '@roamhq/wrtc';
import WebSocket from 'ws';

const { RTCPeerConnection, RTCDataChannel } = wrtc as any;

type Role = 'creator' | 'joiner';

export type PeerOpts = {
  name: string;
  role: Role;
  signalingURL: string; // e.g., wss://ditch.chat
  onOpen: () => void;
  onMessage: (text: string) => void;
  onStatus: (text: string) => void;
  onClose: () => void;
  onIce?: (state: string) => void;
  onTickInactivity?: (totalMs: number) => void;
};

// ---- ICE / TURN config (env-driven) ----
const TURN_URL  = process.env.TURN_URL;
const TURN_USER = process.env.TURN_USER;
const TURN_CRED = process.env.TURN_CRED;

const iceServers: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302'] }
];
if (TURN_URL && TURN_USER && TURN_CRED) {
  iceServers.push({ urls: [TURN_URL], username: TURN_USER, credential: TURN_CRED });
}

const rtcConfig: RTCConfiguration = {
  iceServers,
  iceCandidatePoolSize: 8,
  iceTransportPolicy: process.env.FORCE_RELAY ? 'relay' : 'all'
};

// join retry/backoff
const JOIN_RETRY_TOTAL_MS = Number(process.env.JOIN_RETRY_TOTAL_MS || 15_000);
const JOIN_RETRY_BASE_MS  = Number(process.env.JOIN_RETRY_BASE_MS  || 600);

export class TunnelPeer {
  private pc: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private ws!: WebSocket;
  private opts: PeerOpts;
  private inactivityTimer?: NodeJS.Timeout;
  private readonly INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes

  private wsReconnects = 0;
  private joinedOnce = false;
  private iceRestarted = false;
  private disposed = false;

  constructor(opts: PeerOpts) {
    this.opts = opts;
    this.pc = new RTCPeerConnection(rtcConfig as any);
    this.attachPeerHandlers();
    this.connectWS(); // lazy; will (re)connect
  }

  // ----- Peer event wiring -----
  private attachPeerHandlers() {
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.opts.onStatus(`connection: ${s}`);
      this.opts.onIce?.(this.pc.iceConnectionState);

      if (s === 'connected') {
        this.onActivity();
        this.opts.onOpen();
      } else if (s === 'failed' || s === 'disconnected') {
        // one-time ICE restart attempt to heal transient NAT hiccups
        if (!this.iceRestarted) {
          this.iceRestarted = true;
          this.opts.onStatus('attempting ICE restart…');
          this.restartIce().catch(() => {});
        }
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      this.opts.onStatus(`ICE state: ${s}`);
      this.opts.onIce?.(s);
      if (s === 'connected' || s === 'completed') this.onActivity();
    };

    this.pc.onicegatheringstatechange = () => {
      this.opts.onStatus(`ICE gathering: ${this.pc.iceGatheringState}`);
    };

    this.pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate) this.opts.onStatus('ICE gathering complete');
    };

    if (this.opts.role === 'creator') {
      this.dc = this.pc.createDataChannel('tunnel', { negotiated: false });
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
      this.onActivity();
      const text = typeof ev.data === 'string' ? ev.data : '[binary]';
      this.opts.onMessage(text);
    };
    dc.onclose = () => this.close();
    dc.onerror = () => this.opts.onStatus('data channel error');
  }

  // ----- WS connect/reconnect -----
  private connectWS() {
    if (this.disposed) return;
    this.ws = new WebSocket(this.opts.signalingURL);
    this.ws.on('open', () => {
      this.wsReconnects = 0;
      this.startSignaling();
    });
    this.ws.on('message', (raw) => this.onSignal(JSON.parse(raw.toString())));
    this.ws.on('error', (err) => {
      this.opts.onStatus(`signaling error: ${(err as Error).message || err}`);
    });
    this.ws.on('close', () => {
      if (this.disposed) return;
      // backoff reconnect for signaling
      const delay = Math.min(2000 + this.wsReconnects * 500, 4000);
      this.wsReconnects++;
      setTimeout(() => this.connectWS(), delay);
    });
  }

  // ----- Signaling flow -----
  private async startSignaling() {
    if (this.opts.role === 'creator') {
      const offer = await this.pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await this.pc.setLocalDescription(offer);
      await this.waitForIceGatheringComplete();
      this.safeSend({ type: 'create', name: this.opts.name, sdp: this.pc.localDescription?.sdp });
      this.opts.onStatus(`waiting for a peer to join "${this.opts.name}" …`);
    } else {
      this.joinWithRetry();
    }
  }

  private joinWithRetry() {
    const started = Date.now();
    let attempt = 0;

    const tick = () => {
      if (this.disposed) return;
      const elapsed = Date.now() - started;
      if (elapsed > JOIN_RETRY_TOTAL_MS) {
        // final attempt
        this.safeSend({ type: 'join', name: this.opts.name });
        this.opts.onStatus(`joining "${this.opts.name}" … (last attempt)`);
        return;
      }
      this.safeSend({ type: 'join', name: this.opts.name });
      const delay = Math.min(JOIN_RETRY_BASE_MS * Math.pow(1.4, attempt++), 2000);
      this.opts.onStatus(`joining "${this.opts.name}" … (retry in ${Math.ceil(delay/100)/10}s)`);
      setTimeout(tick, delay);
    };

    tick();
  }

  private async onSignal(msg: any) {
    if (msg.type === 'created') return;
    if (msg.type === 'not_found' && this.opts.role === 'joiner') {
      // keep waiting — server will hold us for JOIN_WAIT_MS but we also retry client-side
      this.opts.onStatus(`tunnel "${this.opts.name}" not found yet…`);
      return;
    }
    if (msg.type === 'offer' && this.opts.role === 'joiner') {
      this.joinedOnce = true;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.waitForIceGatheringComplete();
      this.safeSend({ type: 'answer', name: this.opts.name, sdp: this.pc.localDescription?.sdp });
      this.opts.onStatus('sent answer');
      return;
    }
    if (msg.type === 'answer' && this.opts.role === 'creator') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      this.opts.onStatus('received answer');
      return;
    }
  }

  private waitForIceGatheringComplete(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          res();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private safeSend(obj: any) {
    try {
      if (this.ws && (this.ws as any).readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch {}
  }

  // One-time ICE restart attempt
  private async restartIce() {
    try {
      await this.pc.setConfiguration?.({ ...rtcConfig, iceTransportPolicy: rtcConfig.iceTransportPolicy });
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      await this.waitForIceGatheringComplete();

      if (this.opts.role === 'creator') {
        this.safeSend({ type: 'create', name: this.opts.name, sdp: this.pc.localDescription?.sdp });
        this.opts.onStatus('reposted offer after ICE restart');
      } else {
        // We can’t “join” again for the same name once creator exists; signaler will resend offer to us if needed.
        // For simplicity: request a fresh offer by pinging join again (server will ignore if room active).
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
    this.opts.onTickInactivity?.(this.INACTIVITY_MS);
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      this.opts.onStatus('closing due to inactivity');
      this.close();
    }, this.INACTIVITY_MS);
  }

  close() {
    this.disposed = true;
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
    try { this.ws?.close(); } catch {}
    this.opts.onClose();
  }
}
