'use strict'

var DisplayManager = require('./display_manager')
const EventEmitter = require('events').EventEmitter
const protooServer = require('protoo-server')
const logger = require('./Logger')
const config = require('../config/config')

const MAX_BITRATE = config.mediasoup.maxBitrate || 1000000
const MIN_BITRATE = Math.min(50000, MAX_BITRATE)
const BITRATE_FACTOR = 0.75

class Room extends EventEmitter {
  constructor (roomId, mediaServer) {
    logger.info('constructor() [roomId:"%s"]', roomId)

    super()
    this.setMaxListeners(Infinity)

    // Room ID.
    this._roomId = roomId

    // Closed flag.
    this._closed = false

    try {
      // Protoo Room instance.
      this._protooRoom = new protooServer.Room()

      // mediasoup Room instance.
      this._mediaRoom = mediaServer.Room(config.mediasoup.mediaCodecs)
    } catch (error) {
      this.close()

      throw error
    }

    // Current max bitrate for all the participants.
    this._maxBitrate = MAX_BITRATE

    // Current active speaker.
    // @type {mediasoup.Peer}
    this._currentActiveSpeaker = null

    this._handleMediaRoom()

    // this would hold the peers and create appropriate rtpStreamer for each of this, 
    // the format would be: 
    // peer_name: true -> if we have already created peer. This requires that we 
    // create a whole lot more free ports in due time. 
    this.peers = []
  }

  get id () {
    return this._roomId
  }

  close () {
    logger.debug('close()')

    this._closed = true

    // Close the protoo Room.
    if (this._protooRoom) { this._protooRoom.close() }

    // Close the mediasoup Room.
    if (this._mediaRoom) { this._mediaRoom.close() }

    // Emit 'close' event.
    this.emit('close')
  }

  logStatus () {
    if (!this._mediaRoom) { return }

    logger.info(
      'logStatus() [room id:"%s", protoo peers:%s, mediasoup peers:%s]',
      this._roomId,
      this._protooRoom.peers.length,
      this._mediaRoom.peers.length)
  }

  handleConnection (peerName, transport) {
    logger.info('handleConnection() [peerName:"%s"]', peerName)

    if (this._protooRoom.hasPeer(peerName)) {
      logger.warn(
        'handleConnection() | there is already a peer with same peerName, ' +
    'closing the previous one [peerName:"%s"]',
        peerName)

      const protooPeer = this._protooRoom.getPeer(peerName)

      protooPeer.close()
    }

    const protooPeer = this._protooRoom.createPeer(peerName, transport)

    this._handleProtooPeer(protooPeer)
  }

  _handleMediaRoom () {
    logger.debug('_handleMediaRoom()')

    const activeSpeakerDetector = this._mediaRoom.createActiveSpeakerDetector()

    activeSpeakerDetector.on('activespeakerchange', (activePeer) => {
      if (activePeer) {
        logger.info('new active speaker [peerName:"%s"]', activePeer.name)

        this._currentActiveSpeaker = activePeer

        const activeVideoProducer = activePeer.producers
          .find((producer) => producer.kind === 'video')

        for (const peer of this._mediaRoom.peers) {
          for (const consumer of peer.consumers) {
            if (consumer.kind !== 'video') { continue }

            if (consumer.source === activeVideoProducer) {
              consumer.setPreferredProfile('high')
            } else {
              consumer.setPreferredProfile('low')
            }
          }
        }
      } else {
        logger.info('no active speaker')

        this._currentActiveSpeaker = null

        for (const peer of this._mediaRoom.peers) {
          for (const consumer of peer.consumers) {
            if (consumer.kind !== 'video') { continue }

            consumer.setPreferredProfile('low')
          }
        }
      }

      // Spread to others via protoo.
      this._protooRoom.spread(
        'active-speaker',
        {
          peerName: activePeer ? activePeer.name : null
        })
    })
  }

  _handleProtooPeer (protooPeer) {
    logger.debug('_handleProtooPeer() [peer:"%s"]', protooPeer.id)

    protooPeer.on('request', (request, accept, reject) => {
      logger.debug(
        'protoo "request" event [method:%s, peer:"%s"]',
        request.method, protooPeer.id)

      switch (request.method) {
        case 'mediasoup-request':
        {
          const mediasoupRequest = request.data

          this._handleMediasoupClientRequest(
            protooPeer, mediasoupRequest, accept, reject)

          break
        }

        case 'mediasoup-notification':
        {
          accept()

          const mediasoupNotification = request.data

          this._handleMediasoupClientNotification(
            protooPeer, mediasoupNotification)

          break
        }

        case 'change-display-name':
        {
          accept()

          const { displayName } = request.data
          const { mediaPeer } = protooPeer.data
          const oldDisplayName = mediaPeer.appData.displayName

          mediaPeer.appData.displayName = displayName

          // Spread to others via protoo.
          this._protooRoom.spread(
            'display-name-changed',
            {
              peerName: protooPeer.id,
              displayName: displayName,
              oldDisplayName: oldDisplayName
            },
            [ protooPeer ])

          break
        }

        default:
        {
          logger.error('unknown request.method "%s"', request.method)

          reject(400, `unknown request.method "${request.method}"`)
        }
      }
    })

    protooPeer.on('close', () => {
      logger.debug('protoo Peer "close" event [peer:"%s"]', protooPeer.id)

      const { mediaPeer } = protooPeer.data

      if (mediaPeer && !mediaPeer.closed) { mediaPeer.close() }

      // If this is the latest peer in the room, close the room.
      // However wait a bit (for reconnections).
      setTimeout(() => {
        if (this._mediaRoom && this._mediaRoom.closed) { return }

        if (this._mediaRoom.peers.length === 0) {
          logger.info(
            'last peer in the room left, closing the room [roomId:"%s"]',
            this._roomId)

          this.close()
        }
      }, 5000)
    })
  }

  _handleMediaPeer (protooPeer, mediaPeer) {
    mediaPeer.on('notify', (notification) => {
      protooPeer.send('mediasoup-notification', notification)
        .catch(() => {})
    })

    mediaPeer.on('newtransport', (transport) => {
      logger.info(
        'mediaPeer "newtransport" event [id:%s, direction:%s]',
        transport.id, transport.direction)

      // Update peers max sending  bitrate.
      if (transport.direction === 'send') {
        this._updateMaxBitrate()

        transport.on('close', () => {
          this._updateMaxBitrate()
        })
      }

      this._handleMediaTransport(transport)
    })

    mediaPeer.on('newproducer', (producer) => {
      logger.info('mediaPeer "newproducer" event [id:%s]', producer.id)

      // if this doesn't exist for each both
      // creates for both this value, now for both audio and video. If it has only then okay. 
      this._rtpStreamStart(producer, mediaPeer)
      let typ = this.peers[mediaPeer.name]
      if (!typ) {
        typ = []
      }
      typ[String(producer.kind)] = 'true'
      this.peers[mediaPeer.name] = typ
      logger.info('peers')
      logger.info(this.peers)

      this._handleMediaProducer(producer)
    })

    mediaPeer.on('newconsumer', (consumer) => {
      logger.info('mediaPeer "newconsumer" event [id:%s]', consumer.id)

      this._handleMediaConsumer(consumer)
    })

    // Also handle already existing Consumers.
    for (const consumer of mediaPeer.consumers) {
      logger.info('mediaPeer existing "consumer" [id:%s]', consumer.id)

      this._handleMediaConsumer(consumer)
    }

    // Notify about the existing active speaker.
    if (this._currentActiveSpeaker) {
      protooPeer.send(
        'active-speaker',
        {
          peerName: this._currentActiveSpeaker.name
        })
        .catch(() => {})
    }
  }

  _handleMediaTransport (transport) {
    transport.on('close', (originator) => {
      logger.info(
        'Transport "close" event [originator:%s]', originator)
    })
  }

  _handleMediaProducer (producer) {
    producer.on('close', (originator) => {
      logger.info(
        'Producer "close" event [originator:%s]', originator)
    })

    producer.on('pause', (originator) => {
      logger.info(
        'Producer "pause" event [originator:%s]', originator)
    })

    producer.on('resume', (originator) => {
      logger.info(
        'Producer "resume" event [originator:%s]', originator)
    })
  }

  _handleMediaConsumer (consumer) {
    consumer.on('close', (originator) => {
      logger.info(
        'Consumer "close" event [originator:%s]', originator)
    })

    consumer.on('pause', (originator) => {
      logger.info(
        'Consumer "pause" event [originator:%s]', originator)
    })

    consumer.on('resume', (originator) => {
      logger.info(
        'Consumer "resume" event [originator:%s]', originator)
    })

    consumer.on('effectiveprofilechange', (profile) => {
      logger.info(
        'Consumer "effectiveprofilechange" event [profile:%s]', profile)
    })

    // If video, initially make it 'low' profile unless this is for the current
    // active speaker.
    if (consumer.kind === 'video' && consumer.peer !== this._currentActiveSpeaker) { consumer.setPreferredProfile('low') }
  }

  _handleMediasoupClientRequest (protooPeer, request, accept, reject) {
    logger.debug(
      'mediasoup-client request [method:%s, peer:"%s"]',
      request.method, protooPeer.id)

    switch (request.method) {
      case 'queryRoom':
      {
        this._mediaRoom.receiveRequest(request)
          .then((response) => accept(response))
          .catch((error) => reject(500, error.toString()))

        break
      }

      case 'join':
      {
        // TODO: Handle appData. Yes?
        const { peerName } = request

        if (peerName !== protooPeer.id) {
          reject(403, 'that is not your corresponding mediasoup Peer name')

          break
        } else if (protooPeer.data.mediaPeer) {
          reject(500, 'already have a mediasoup Peer')

          break
        }

        this._mediaRoom.receiveRequest(request)
          .then((response) => {
            accept(response)

            // Get the newly created mediasoup Peer.
            const mediaPeer = this._mediaRoom.getPeerByName(peerName)

            protooPeer.data.mediaPeer = mediaPeer

            this._handleMediaPeer(protooPeer, mediaPeer)
          })
          .catch((error) => {
            reject(500, error.toString())
          })

        break
      }

      default:
      {
        const { mediaPeer } = protooPeer.data

        if (!mediaPeer) {
          logger.error(
            'cannot handle mediasoup request, no mediasoup Peer [method:"%s"]',
            request.method)

          reject(400, 'no mediasoup Peer')
        }

        mediaPeer.receiveRequest(request)
          .then((response) => accept(response))
          .catch((error) => reject(500, error.toString()))
      }
    }
  }

  _handleMediasoupClientNotification (protooPeer, notification) {
    logger.debug(
      'mediasoup-client notification [method:%s, peer:"%s"]',
      notification.method, protooPeer.id)

    // NOTE: mediasoup-client just sends notifications with target 'peer',
    // so first of all, get the mediasoup Peer.
    const { mediaPeer } = protooPeer.data

    if (!mediaPeer) {
      logger.error(
        'cannot handle mediasoup notification, no mediasoup Peer [method:"%s"]',
        notification.method)

      return
    }

    mediaPeer.receiveNotification(notification)
  }

  _updateMaxBitrate () {
    if (this._mediaRoom.closed) { return }

    const numPeers = this._mediaRoom.peers.length
    const previousMaxBitrate = this._maxBitrate
    let newMaxBitrate

    if (numPeers <= 2) {
      newMaxBitrate = MAX_BITRATE
    } else {
      newMaxBitrate = Math.round(MAX_BITRATE / ((numPeers - 1) * BITRATE_FACTOR))

      if (newMaxBitrate < MIN_BITRATE) { newMaxBitrate = MIN_BITRATE }
    }

    this._maxBitrate = newMaxBitrate

    for (const peer of this._mediaRoom.peers) {
      for (const transport of peer.transports) {
        if (transport.direction === 'send') {
          transport.setMaxBitrate(newMaxBitrate)
            .catch((error) => {
              logger.error('transport.setMaxBitrate() failed: %s', String(error))
            })
        }
      }
    }

    logger.info(
      '_updateMaxBitrate() [num peers:%s, before:%skbps, now:%skbps]',
      numPeers,
      Math.round(previousMaxBitrate / 1000),
      Math.round(newMaxBitrate / 1000))
  }
  _rtpStreamStart (producer, mediaPeer) {
    var that = this
    if (producer.kind === 'video') {
      // Here I need to set different people values.
      DisplayManager.getFreePort('dummy', (error, port, more) => {
        if (error) logger.error(error)
        that._mediaRoom.createRtpStreamer(producer, {'remoteIP': config.mediasoup.rtpConfig.video.remoteIP, 'remotePort': port[0]}).then((rtpStreamer) => {
          logger.info(producer.kind)
          logger.info('transport id %s', rtpStreamer.transport.id)
          logger.info('transport tuple')
          logger.info(rtpStreamer.transport.tuple)
          logger.info('transport open or closed')
          logger.info(rtpStreamer.transport.closed)
          logger.info('Consumer rtpParameters')
          // Pass this to the docker container.
          // TODO call rpc manager soon with SDP session codecs
          logger.info(rtpStreamer.consumer.rtpParameters.codecs)
          // with this build a sdp parameter
          logger.info('Consumer rtpParameters')
        })
        // TODO Connect it with the underlying connection.
        logger.info({'remoteIP': config.mediasoup.rtpConfig.video.remoteIP, 'remotePort': port})
      })
    } else {
      DisplayManager.getFreePort('dummy', (error, port, more) => {
        if (error) logger.error(error)
        that._mediaRoom.createRtpStreamer(producer, {'remoteIP': config.mediasoup.rtpConfig.audio.remoteIP, 'remotePort': port[0]}).then((rtpStreamer) => {
          logger.info(producer.kind)
          logger.info('transport id %s', rtpStreamer.transport.id)
          logger.info('transport tuple')
          logger.info(rtpStreamer.transport.tuple)
          logger.info('transport open or closed')
          logger.info(rtpStreamer.transport.closed)
          logger.info('Consumer rtpParameters')
          // pass this to the docker container
          // TODO call rpc manager with SDP session codecs.
          logger.info(rtpStreamer.consumer.rtpParameters.codecs)
          logger.info('Consumer rtpParameters')
        })
        // .on('close', () => { logger.info('closed') })
        logger.info({'remoteIP': config.mediasoup.rtpConfig.audio.remoteIP, 'remotePort': port})
      })
    }
  }
}

module.exports = Room
