// cli/peer.ts
import wrtc from '@roamhq/wrtc';
import WebSocket from 'ws';
const { RTCPeerConnection, RTCDataChannel } = wrtc;
// Use public STUN for MVP.
// (Traffic remains E2E encrypted over DTLS even if a relay is used.)
const rtcConfig = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    iceCandidatePoolSize: 8
};
export class TunnelPeer {
    pc;
    dc;
    ws;
    opts;
    inactivityTimer;
    INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes
    constructor(opts) {
        this.opts = opts;
        this.pc = new RTCPeerConnection(rtcConfig);
        this.ws = new WebSocket(opts.signalingURL);
        this.pc.onconnectionstatechange = () => {
            const s = this.pc.connectionState;
            if (s === 'connected') {
                this.opts.onStatus(`connected to ${opts.name}`);
                this.onActivity();
                this.opts.onOpen();
            }
            else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                this.opts.onStatus(`connection ${s}`);
                this.close();
            }
        };
        if (opts.role === 'creator') {
            this.dc = this.pc.createDataChannel('tunnel', { negotiated: false });
            this.wireChannel(this.dc);
        }
        else {
            this.pc.ondatachannel = (ev) => {
                this.dc = ev.channel;
                this.wireChannel(this.dc);
            };
        }
        this.ws.on('open', () => this.startSignaling());
        this.ws.on('message', (raw) => this.onSignal(JSON.parse(raw.toString())));
        this.ws.on('close', () => { });
    }
    wireChannel(dc) {
        dc.onopen = () => this.opts.onStatus('data channel open');
        dc.onmessage = (ev) => {
            this.onActivity();
            const text = typeof ev.data === 'string' ? ev.data : '[binary]';
            this.opts.onMessage(text);
        };
        dc.onclose = () => this.close();
        dc.onerror = () => this.opts.onStatus('data channel error');
    }
    async startSignaling() {
        if (this.opts.role === 'creator') {
            const offer = await this.pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
            await this.pc.setLocalDescription(offer);
            await this.waitForIceGatheringComplete();
            this.ws.send(JSON.stringify({ type: 'create', name: this.opts.name, sdp: this.pc.localDescription?.sdp }));
            this.opts.onStatus(`waiting for a peer to join "${this.opts.name}" …`);
        }
        else {
            this.ws.send(JSON.stringify({ type: 'join', name: this.opts.name }));
            this.opts.onStatus(`joining "${this.opts.name}" …`);
        }
    }
    async onSignal(msg) {
        if (msg.type === 'created')
            return; // ack
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
            return;
        }
        if (msg.type === 'answer' && this.opts.role === 'creator') {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            return;
        }
    }
    waitForIceGatheringComplete() {
        if (this.pc.iceGatheringState === 'complete')
            return Promise.resolve();
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
    send(text) {
        if (this.dc?.readyState === 'open') {
            this.dc.send(text);
            this.onActivity();
            return true;
        }
        return false;
    }
    onActivity() {
        if (this.inactivityTimer)
            clearTimeout(this.inactivityTimer);
        this.inactivityTimer = setTimeout(() => {
            this.opts.onStatus('closing due to inactivity');
            this.close();
        }, this.INACTIVITY_MS);
    }
    close() {
        try {
            this.dc?.close();
        }
        catch { }
        try {
            this.pc.close();
        }
        catch { }
        try {
            this.ws.close();
        }
        catch { }
        this.opts.onClose();
    }
}
