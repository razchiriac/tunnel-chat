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

  // NEW: drive UI indicator + countdown
  onIce?: (state: string) => void;
  onTickInactivity?: (totalMs: number) => void;
};

// ---- ICE / TURN config (env-driven) ----------------------------------
// Optional TURN for strict NATs (set on both peers when needed):
//   TURN_URL="turn:turn.example.com:3478?transport=udp"
//   TURN_USER="demo"
//   TURN_CRED="demoPass123"
// To force relaying (bypass direct P2P), set: FORCE_RELAY=1
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

export class TunnelPeer {
  private pc: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private ws: WebSocket;
  private opts: PeerOpts;
  private inactivityTimer?: NodeJS.Timeout;
  private readonly INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes

  constructor(opts: PeerOpts) {
    this.opts = opts;
    this.pc = new RTCPeerConnection(rtcConfig as any);
    this.ws = new WebSocket(opts.signalingURL);

    // ---- Connection state (overall) -----------------------------------
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.opts.onStatus(`connection: ${s}`);
      this.opts.onIce?.(this.pc.iceConnectionState); // keep UI in sync

      if (s === 'connected') {
        this.onActivity(); // start inactivity timer
        this.opts.onOpen();
      } else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        this.close();
      }
    };

    // ---- ICE visibility (for UI indicator / debugging) ----------------
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

    // ---- DataChannel setup --------------------------------------------
    if (opts.role === 'creator') {
      this.dc = this.pc.createDataChannel('tunnel', { negotiated: false });
      this.wireChannel(this.dc);
    } else {
      this.pc.ondatachannel = (ev: RTCDataChannelEvent) => {
        this.dc = ev.channel;
        this.wireChannel(this.dc);
      };
    }

    // ---- Signaling WS --------------------------------------------------
    this.ws.on('open', () => this.startSignaling());
    this.ws.on('message', (raw) => this.onSignal(JSON.parse(raw.toString())));
    this.ws.on('close', () => { /* no-op */ });
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

  private async startSignaling() {
    if (this.opts.role === 'creator') {
      const offer = await this.pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await this.pc.setLocalDescription(offer);
      await this.waitForIceGatheringComplete();
      this.ws.send(JSON.stringify({ type: 'create', name: this.opts.name, sdp: this.pc.localDescription?.sdp }));
      this.opts.onStatus(`waiting for a peer to join "${this.opts.name}" …`);
    } else {
      this.ws.send(JSON.stringify({ type: 'join', name: this.opts.name }));
      this.opts.onStatus(`joining "${this.opts.name}" …`);
    }
  }

  private async onSignal(msg: any) {
    if (msg.type === 'created') return; // ack
    if (msg.type === 'not_found' && this.opts.role === 'joiner') {
      this.opts.onStatus(`tunnel "${this.opts.name}" not found.`);
      this.close();
      return;
    }
    if (msg.type === 'offer' && this.opts.role === 'joiner') {
      await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.waitForIceGatheringComplete();
      this.ws.send(JSON.stringify({ type: 'answer', name: this.opts.name, sdp: this.pc.localDescription?.sdp }));
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

  send(text: string) {
    if (this.dc?.readyState === 'open') {
      this.dc.send(text);
      this.onActivity();
      return true;
    }
    return false;
  }

  private onActivity() {
    // Notify UI to reset its countdown
    this.opts.onTickInactivity?.(this.INACTIVITY_MS);

    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      this.opts.onStatus('closing due to inactivity');
      this.close();
    }, this.INACTIVITY_MS);
  }

  close() {
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
    try { this.ws.close(); } catch {}
    this.opts.onClose();
  }
}
