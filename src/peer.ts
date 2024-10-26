/* eslint-disable no-param-reassign */
import { EventEmitter } from './emitter';
import { Arguments, PeerEvents, PeerOptions, TypedEmitter } from './types';
import { getDefaultCamConstraints, getSenderForTrack, randomHex, removeTrack } from './utils';

const POLITE_DEFAULT_VALUE = true;

export default class Peer {
  private peer: RTCPeerConnection;

  private readonly streamLocal: MediaStream = new MediaStream();

  private readonly channels = new Map<string, RTCDataChannel>();

  private readonly channelsPending = new Map<string, RTCDataChannelInit>();

  private readonly emitter = new EventEmitter() as TypedEmitter<PeerEvents>;

  private polite = POLITE_DEFAULT_VALUE;

  private isActive = false;

  private makingOffer = false;

  private ignoreOffer = false;

  private readonly options: Required<PeerOptions> = {
    batchCandidates: true,
    batchCandidatesTimeout: 200,
    id: randomHex(4),
    config: {
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    },
    offerOptions: {},
    enableDataChannels: false,
    channelLabel: randomHex(20),
    channelOptions: {},
    sdpTransform: (sdp) => sdp,
  };

  /** Create a peer instance */
  public constructor(options?: PeerOptions) {
    this.options = { ...this.options, ...options };
    this.peer = this.init();
  }

  /** Initialize the peer */
  public init(): RTCPeerConnection {
    // do not reset connection if a new one already exists
    if (this.status() === 'new') {
      return this.peer;
    }
    // close any existing active peer connections
    this.destroy();
    // create peer connection
    this.peer = new RTCPeerConnection(this.options.config);
    // setup peer connection events
    const candidates: RTCIceCandidate[] = [];
    let candidatesId: ReturnType<typeof window.setTimeout>;

    function clearBatchedCandidates() {
      clearTimeout(candidatesId);
      candidates.length = 0;
    }

    this.peer.onicecandidate = (event) => {
      if (!event?.candidate) return;
      // if batching candidates then setup timeouts
      if (this.options.batchCandidates) {
        // clear timeout and push new candidate into batch
        clearTimeout(candidatesId);
        candidates.push(event.candidate);
        // return all candidates if finished gathering
        if (this.peer.iceGatheringState === 'complete') {
          this.emit('onicecandidates', candidates);
        } else {
          // create timeout to return candidates after 200ms
          candidatesId = setTimeout(() => {
            if (candidates.length) {
              this.emit('onicecandidates', candidates);
              clearBatchedCandidates();
            }
          }, this.options.batchCandidatesTimeout);
        }
      } else {
        // if not batching candidates then return them individually
        this.emit('onicecandidates', [event.candidate]);
      }
    };

    this.peer.ontrack = (event) => {
      if (event.streams) {
        this.emit('streamRemote', event.streams[0]);
      }
    };

    this.peer.oniceconnectionstatechange = () => {
      this.emit('status', this.status());
      switch (this.status()) {
        case 'closed':
        case 'failed':
        case 'disconnected': {
          clearBatchedCandidates();
          this.destroy();
          break;
        }
        case 'checking': {
          this.emit('connecting');
          break;
        }
        case 'connected': {
          console.log(`${this.options.id}.connected()`);
          this.emit('connected');
          break;
        }
        default:
          break;
      }
    };

    this.peer.onnegotiationneeded = async () => {
      try {
        if (!this.isActive) return;

        this.makingOffer = true;

        const { offerOptions, sdpTransform } = this.options;
        const offer = await this.peer.createOffer(offerOptions);
        if (this.peer.signalingState !== 'stable') return;

        console.log(`${this.options.id}.onnegotiationneeded()`);
        offer.sdp = offer.sdp && sdpTransform(offer.sdp);
        await this.peer.setLocalDescription(offer);

        if (this.peer.localDescription) {
          console.log(this.options.id, '->', offer.type);
          this.emit('signal', this.peer.localDescription);
        }
      } catch (err) {
        if (err instanceof Error) {
          this.error('Failed in negotiationNeeded', err);
        }
      } finally {
        this.makingOffer = false;
      }
    };

    this.peer.ondatachannel = (event) => {
      // called for in-band non-negotiated data channels
      const { channel } = event;
      if (this.options.enableDataChannels) {
        this.channels.set(channel.label, channel);
        this.addDataChannelEvents(channel);
      }
    };

    return this.peer;
  }

  /** Start the RTCPeerConnection signalling */
  public start({ polite = POLITE_DEFAULT_VALUE } = {}) {
    try {
      if (this.peer.signalingState === 'have-local-offer') {
        this.destroy();
      }
      if (this.isClosed()) {
        this.init();
      }

      console.log(`${this.options.id}.start()`);

      this.isActive = true;
      this.polite = polite;

      // ⚡ triggers "negotiationneeded" event
      this.syncStreams();
      // ⚡ triggers "negotiationneeded" event
      this.syncChannels();
    } catch (err) {
      if (err instanceof Error) {
        this.error('Failed to start', err);
        throw err;
      }
    }
  }

  /** Process a RTCSessionDescriptionInit on peer */
  public async signal(description: RTCSessionDescriptionInit) {
    try {
      if (this.isClosed()) {
        this.init();
      }

      console.log(this.options.id, '<-', description.type);

      this.isActive = true;
      const offerCollision =
        description.type === 'offer' && (this.makingOffer || this.peer.signalingState !== 'stable');

      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        console.log(this.options.id, '- ignoreOffer');
        return;
      }

      await this.peer.setRemoteDescription(description);
      if (description.type === 'offer') {
        // ⚡ triggers "negotiationneeded" event
        this.syncStreams();
        // ⚡ triggers "negotiationneeded" event
        this.syncChannels();

        const answer = await this.peer.createAnswer();
        answer.sdp = answer.sdp && this.options.sdpTransform(answer.sdp);
        await this.peer.setLocalDescription(answer);

        console.log(this.options.id, '->', answer.type);
        this.emit('signal', answer);
      }
      this.polite = POLITE_DEFAULT_VALUE;
    } catch (err) {
      if (err instanceof Error) {
        this.error('Failed to signal', err);
        throw err;
      }
    }
  }

  /** Add RTCIceCandidate to peer */
  public async addIceCandidate(candidate: RTCIceCandidate) {
    try {
      console.log(this.options.id, '<-', 'icecandidate');
      await this.peer.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer && err instanceof Error) {
        this.error('Failed to addIceCandidate', err);
        throw err;
      }
    }
  }

  /** Send data to connected peer using an RTCDataChannel */
  public send(
    data: string | Blob | ArrayBuffer | ArrayBufferView,
    label: string = this.options.channelLabel
  ): boolean {
    const channel = this.channels.get(label);
    if (channel?.readyState === 'open' && data) {
      channel.send(data);
      this.emit('channelData', { channel, data, source: 'outgoing' });
      return true;
    }
    return false;
  }

  /** Add RTCDataChannel to peer */
  public addDataChannel(
    label: string = this.options.channelLabel,
    options: RTCDataChannelInit = {}
  ) {
    if (!this.options.enableDataChannels) {
      this.error('Failed to addDataChannel as "enableDataChannels" is false');
      return;
    }
    if (this.isClosed()) {
      this.error('Failed to addDataChannel as peer connection is closed');
      return;
    }
    if (!this.channels.has(label)) {
      this.channelsPending.set(label, options);
    }
    if (this.isActive) {
      this.createDataChannels();
    }
  }

  /** Get RTCDataChannel added to peer */
  public getDataChannel(label: string = this.options.channelLabel) {
    return this.channels.get(label);
  }

  private createDataChannels() {
    try {
      Array.from(this.channelsPending.entries()).forEach(([label, options]) => {
        // ⚡ triggers "negotiationneeded" event if no other data channels already added
        const channel = this.peer.createDataChannel(label, options);
        this.channels.set(label, channel);
        this.addDataChannelEvents(channel);
      });
      this.channelsPending.clear();
    } catch (err) {
      if (err instanceof Error) {
        this.error('Failed to createDataChannels', err);
        throw err;
      }
    }
  }

  private addDataChannelEvents(channel: RTCDataChannel) {
    channel.onopen = () => this.emit('channelOpen', { channel });
    channel.onerror = (ev: Event) => {
      const event = ev as RTCErrorEvent;
      this.emit('channelError', { channel, event });
    };
    channel.onclose = () => {
      this.channels.delete(channel.label);
      this.emit('channelClosed', { channel });
    };
    channel.onmessage = (event: MessageEvent<string | Blob | ArrayBuffer | ArrayBufferView>) => {
      this.emit('channelData', { channel, data: event.data, source: 'incoming' });
    };
  }

  /** Close peer if active */
  public destroy() {
    if (!this.isClosed()) {
      this.polite = POLITE_DEFAULT_VALUE;
      this.isActive = false;
      this.makingOffer = false;
      this.ignoreOffer = false;
      this.channels.clear();
      this.channelsPending.clear();
      this.peer.close();
      console.log(`${this.options.id}.disconnected()`);
      this.emit('disconnected');
    }
  }

  /** Return the ICEConnectionState of the peer */
  public status(): RTCIceConnectionState {
    return this.peer?.iceConnectionState ?? 'closed';
  }

  /** Return true if the peer is connected */
  public isConnected() {
    return this.status() === 'connected';
  }

  /** Return true if the peer is closed */
  public isClosed() {
    return this.status() === 'closed';
  }

  /** Return the RTCPeerConnection */
  public get() {
    return this.peer;
  }

  /** Return the local stream */
  public getStreamLocal() {
    return this.streamLocal;
  }

  private error(message: string, error?: Error) {
    console.error(`${this.options.id}`, message, error ? `- ${error.toString()}` : '');
    this.emit('error', { id: this.options.id, message, error });
  }

  private syncStreams() {
    this.streamLocal.getTracks().forEach((track) => {
      const sender = getSenderForTrack(this.peer, track);
      if (!sender) {
        this.peer.addTrack(track, this.streamLocal);
      }
    });
  }

  private syncChannels() {
    const { channelLabel, channelOptions, enableDataChannels } = this.options;
    if (enableDataChannels) {
      this.addDataChannel(channelLabel, channelOptions);
    }
  }

  // helpers

  /** Add stream to peer */
  public addStream(stream: MediaStream, replace = false, stopTracks = true) {
    if (replace) {
      this.removeTracks(this.streamLocal.getTracks(), stopTracks);
    }
    stream.getTracks().forEach((track) => this.addTrack(track));
  }

  /** Remove stream from peer */
  public removeStream(stream: MediaStream, stopTracks = true) {
    this.removeTracks(stream.getTracks(), stopTracks);
  }

  /** Add track to peer */
  public addTrack(track: MediaStreamTrack) {
    try {
      this.streamLocal.addTrack(track);
      this.emit('streamLocal', this.streamLocal);
      if (this.isActive) {
        // ⚡ triggers "negotiationneeded" event
        this.peer.addTrack(track, this.streamLocal);
      }
    } catch (err) {
      if (err instanceof Error) {
        this.error('Failed to addTrack', err);
        throw err;
      }
    }
  }

  /** Remove track on peer */
  public removeTrack(track: MediaStreamTrack, stopTrack = true) {
    removeTrack(this.streamLocal, track, stopTrack);
    if (this.isActive) {
      const sender = getSenderForTrack(this.peer, track);
      if (sender) {
        // ⚡ triggers "negotiationneeded" event
        this.peer.removeTrack(sender);
      }
    }
  }

  /** Remove tracks on peer */
  public removeTracks(tracks: MediaStreamTrack[], stopTracks = true) {
    tracks.forEach((track) => this.removeTrack(track, stopTracks));
  }

  /** Replace track with another track on peer */
  public async replaceTrack(
    track: MediaStreamTrack,
    newTrack: MediaStreamTrack,
    stopOldTrack = true
  ) {
    try {
      if (this.isActive) {
        const sender = getSenderForTrack(this.peer, track);
        if (sender) {
          // remove/add track on local stream
          removeTrack(this.streamLocal, track, stopOldTrack);
          this.streamLocal.addTrack(newTrack);
          // replace track on peer connection - will error if renegotiation needed
          await sender.replaceTrack(newTrack);
          this.emit('streamLocal', this.streamLocal);
        } else {
          this.error(`Failed to find track to replace: ${track.id}`);
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        this.error('Failed to replaceTrack', err);
        throw err;
      }
    }
  }

  // emitter

  public on<E extends keyof PeerEvents>(event: E, listener: PeerEvents[E]) {
    return this.emitter.on(event, listener);
  }

  public off<E extends keyof PeerEvents>(event: E, listener: PeerEvents[E]) {
    return this.emitter.off(event, listener);
  }

  public offAll<E extends keyof PeerEvents>(event?: E) {
    return this.emitter.offAll(event);
  }

  private emit<E extends keyof PeerEvents>(event: E, ...args: Arguments<PeerEvents[E]>) {
    return this.emitter.emit(event, ...args);
  }

  // statics

  public static getUserMedia(constraints?: MediaStreamConstraints) {
    return navigator.mediaDevices.getUserMedia({
      ...getDefaultCamConstraints(),
      ...constraints,
    });
  }
}
