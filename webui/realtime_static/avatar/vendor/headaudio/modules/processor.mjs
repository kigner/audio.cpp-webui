import * as PARAMS from "./parameters.mjs";
import { RingBuffer } from "./ringbuffer.mjs";
import { MFCC } from "./mfcc.mjs";
import { VadGate } from "./vadgate.mjs";
import { Classifier } from "./classifier.mjs";


/**
* Audio processor for handling audio-driven viseme detection.
* 
* @class 
* @author Mika Suominen
*/
class Processor {

  /**
  * Creates a new instance of the audio processor.
  * 
  * @constructor
  * @param {object} [options] Initialization data
  * @param {object} [worklet=null] Audio worket processor.
  */
  constructor(options, worklet=null) {

    // Options
    const po = Object.assign({
      vadEventsEnabled: false,
      frameEventsEnabled: false,
      featureEventsEnabled: false,
      visemeEventsEnabled: false
    }, options?.processorOptions || {});
    const pd = Object.assign({
      vadMode: 1,
      vadGateActiveDb: -40,
      vadGateActiveMs: 10,
      vadGateInactiveDb: -50,
      vadGateInactiveMs: 10,
      silMode: 1,
      silCalibrationWindowSec: 3.0,
      silSensitivity: 1.2 
    }, options?.parameterData || {});

    // Worklet, use dummy for testing
    this.worklet = worklet || {
      port: {
        onmessage: null,
        postMessage: (o) => {}
      }
    };

    // Can be overridden for training
    this.sampleRate = options.sampleRate;
    this.samplesN = options.samplesN || PARAMS.MFCC_SAMPLES_N;
    this.samplesHop = options.samplesHop || PARAMS.MFCC_SAMPLES_HOP;

    // Pre-emphasis
    this.preemphasisPrevValue = 0;

    // Downsample
    this.downsampleRatio = this.sampleRate / PARAMS.AUDIO_SAMPLE_RATE;
    this.downsamplePhaseAccumulator = 0;
    this.downsamplePolyFilter = this.designPolyphaseFilter(); // Precompute polyphase filter table
    this.ringPolyFilter = new RingBuffer(PARAMS.AUDIO_DOWNSAMPLE_FILTER_N, () => 0, true); // Circular buffer

    // Block
    this.ringSamples = new RingBuffer( this.samplesN, () => 0 );
    this.block = new Float32Array(this.samplesN);

    // MFCC
    this.mfcc = new MFCC(options);

    // Vector = MFCC + delta
    this.ringVectors = new RingBuffer( 3, () => new Float32Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS), true );
    this.vectorDuration = this.samplesN / PARAMS.AUDIO_SAMPLE_RATE;

    // VAD
    this.vadMode = pd.vadMode;
    this.vadGate = new VadGate(pd);
    this.isRunning = true;
    this.isSpeaking = false;

    // Silence
    this.silMode = pd.silMode;
    const calibrationWindowN = Math.max( 100, Math.floor( pd.silCalibrationWindowSec * PARAMS.MFCC_SAMPLES_HOP / PARAMS.AUDIO_SAMPLE_RATE ));
    this.ringCalibration = new RingBuffer( calibrationWindowN );
    this.isCalibrationRunning = false;

    // Events
    this.frameEventsEnabled = !!po.frameEventsEnabled;
    this.vadEventsEnabled = !!po.vadEventsEnabled;
    this.featureEventsEnabled = !!po.featureEventsEnabled;
    this.visemeEventsEnabled = !!po.visemeEventsEnabled;

    // Frame events (support for testing, Node.js only)
    if ( this.frameEventsEnabled ) {
      this.ringFrame = new RingBuffer( 128 );
    }

    // Timing
    this.sampleCount = 0;

    // Gaussian prototype classifier
    this.classifier = new Classifier(pd);

  }

  /**
  * Event handler.
  * 
  * @param {Object} message Message from main thread.
  */
  _onmessage(message) {
    const data = message.data;

    switch (data.event) {
      case 'stop':
        this.isRunning = false;
        if ( this.isSpeaking ) {
          this.isSpeaking = false;
          const t = this.sampleCount / PARAMS.AUDIO_SAMPLE_RATE; // Seconds
          this.worklet.port.postMessage({ event: 'end', t });
        }
        this.ringVectors.clear(); // Clear ring buffer
        break;

      case "start":
        this.isRunning = true;
        break;

      case "calibrate":
        this.ringCalibration.clear();
        this.isCalibrationRunning = true;
        break;

      case 'model':
        this.classifier.import( data );
        break;

      case 'reset':
        this.ringSamples.clear();
        this.ringVectors.clear();
        this.sampleCount = 0;
        break;

      default:
        console.warn("Processor received an unknown message: '" + data.event + "'." );
    }
  }

  /**
  * Generates a polyphase low-pass filter table for downsampling. Each phase
  * contains a Hamming-windowed sinc filter shifted by a fractional offset.
  *
  * @returns {Float32Array[]} Array of filter coefficient arrays, one per phase.
  */
  designPolyphaseFilter() {
    const table = [];
    const mid = (PARAMS.AUDIO_DOWNSAMPLE_FILTER_N - 1) / 2;
    const cutoff = 0.45; // normalized to Nyquist of output

    for (let p = 0; p < PARAMS.AUDIO_DOWNSAMPLE_PHASE_N; p++) {
      const phase = p / PARAMS.AUDIO_DOWNSAMPLE_PHASE_N;
      const coeffs = new Float32Array(PARAMS.AUDIO_DOWNSAMPLE_FILTER_N);
      for (let i = 0; i < PARAMS.AUDIO_DOWNSAMPLE_FILTER_N; i++) {
        const x = i - mid - phase;
        coeffs[i] = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        coeffs[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (PARAMS.AUDIO_DOWNSAMPLE_FILTER_N - 1)); // Hamming
      }
      table.push(coeffs);
    }
    return table;
  }

  /**
  * Update options.
  * 
  * @param {object} options Options
  */
  update(options) {

    for (const name in options) {
      const value = options[name];
      switch(name) {
        case "vadMode":
          this.vadMode = value;
          break;

        case "silMode":
          this.silMode = value;
          break;

        case "silSensitivity":
          this.silSensitivity = value;
          break;
        
        case "silCalibrationWindowSec":
          const calibrationWindowN = Math.max( 100, Math.floor( value * PARAMS.MFCC_SAMPLES_HOP / PARAMS.AUDIO_SAMPLE_RATE ));
          this.ringCalibration = new RingBuffer( calibrationWindowN );
          break;
        
        case "speakerMeanHz":
          this.mfcc.update({ speakerMeanHz: value });
          break;
        
        case "timerReset":
          this.sampleCount = 0;
          break;

        default:
          if ( name.startsWith("vadGate") ) {
            const o = {};
            o[name] = value;
            this.vadGate.update(o);
          }
      }
    }

  }

  /**
  * Called by the AudioWorklet to process audio data.
  *
  * @param {Float32Array} data Mono samples
  */
  process(data) {

    // Data to process?
    const M = data.length;
    if ( M === 0 ) {
      return;
    }

    // Frame event preparation
    if ( this.frameEventsEnabled ) {
      this.ringFrame.clear();
    }

    for (let i = 0; i < M; i++) {

      // Original sample
      let d0 = data[i];

      // Pre-emphasis
      if ( PARAMS.AUDIO_PREEMPHASIS_ENABLED ) {
        const dOrig = d0;
        d0 -= PARAMS.AUDIO_PREEMPHASIS_ALPHA * this.preemphasisPrevValue;
        this.preemphasisPrevValue = dOrig;
      }

      // Downsample
      this.ringPolyFilter.add(d0);
      this.downsamplePhaseAccumulator += 1 / this.downsampleRatio;
      while (this.downsamplePhaseAccumulator >= 1) {
        const phaseFraction = (this.downsamplePhaseAccumulator - 1) * PARAMS.AUDIO_DOWNSAMPLE_PHASE_N;
        const phaseIndex = Math.floor(phaseFraction);
        const coeffs = this.downsamplePolyFilter[phaseIndex];
        
        // Downsampled sample
        let d1 = 0;
        const filter = this.ringPolyFilter;
        for (let j = 0; j < PARAMS.AUDIO_DOWNSAMPLE_FILTER_N; j++) {
          d1 += filter.getHead(j) * coeffs[j];
        }

        this.downsamplePhaseAccumulator -= 1;

        // Frames
        if ( this.frameEventsEnabled ) {
          this.ringFrame.add(d1);
        }

        // Add sample to ring
        this.ringSamples.add(d1);
        this.sampleCount++;

        // If we have enough samples, calculate MFCC
        if ( this.isRunning && this.ringSamples.isFull() ) {

          // Time
          const t = this.sampleCount / PARAMS.AUDIO_SAMPLE_RATE; // Seconds

          // Get block
          const block = this.block;
          this.ringSamples.getLatest(block, this.samplesHop);

          // Calculate feature vector
          const v = this.ringVectors.allocate();
          const { le } = this.mfcc.compute(block, v);

          // Tanh compression
          if ( PARAMS.MFCC_COMPRESSION_ENABLED ) {
            const scale = 1.0 / PARAMS.MFCC_COMPRESSION_TANH_R;
            for (let j = 0; j < PARAMS.MFCC_COEFF_N; ++j) {
              const y = v[j] * scale;
              v[j] = PARAMS.MFCC_COMPRESSION_TANH_R * Math.tanh(y);
            }
          }

          // Calculate deltas
          if ( PARAMS.MFCC_DELTAS_ENABLED ) {
            const vLag2 = this.ringVectors.getTail(-2);

            if ( PARAMS.MFCC_DELTA_DELTAS_ENABLED )  {
              for( let j=0; j<PARAMS.MFCC_COEFF_N; j++ ) {
                v[j+PARAMS.MFCC_COEFF_N] = (v[j] - vLag2[j]) / 2;
                v[j+PARAMS.MFCC_COEFF_N+PARAMS.MFCC_COEFF_N] = (v[j+PARAMS.MFCC_COEFF_N] - vLag2[j+PARAMS.MFCC_COEFF_N]) / 2;
              }
            } else {
              for( let j=0; j<PARAMS.MFCC_COEFF_N; j++ ) {
                v[j+PARAMS.MFCC_COEFF_N] = (v[j] - vLag2[j]) / 2;
              }
            }

          }

          // Silence calibration
          if ( this.isCalibrationRunning && this.silMode === 1 ) {
            const w = v.slice();
            const r = this.ringCalibration;

            r.add(w);
            if ( r.isFull() ) {
              this.worklet.port.postMessage({ event: 'calibrated', vs: r.buf });
              this.isCalibrationRunning = false;
            }
          }

          // VAD gate
          if ( this.vadMode === 1 ) {
            const { active, inactive } = this.vadGate.process(le);

            // Send VAD event
            if ( this.vadEventsEnabled ) {
              this.worklet.port.postMessage({
                event: 'vad',
                active,
                inactive,
                db: 10 * le,
                t
              });
            }

            // If silence detected, we skip the rest
            if ( inactive ) {
              if ( this.isSpeaking ) {
                this.isSpeaking = false;
                this.worklet.port.postMessage({ event: 'ended', t });
              }
              continue;
            }
          }

          // Send feature event
          if ( this.featureEventsEnabled ) {
            this.worklet.port.postMessage({
              event: 'feature',
              vector: v,
              le: le,
              t: t - this.vectorDuration / 2,
              d: this.vectorDuration
            });
          }

          // Predict
          const { viseme, distances } = this.classifier.predict( v );

          // Start/stop speaking
          if ( this.isSpeaking ) {
            if ( viseme === PARAMS.MODEL_VISEME_SIL ) {
              this.isSpeaking = false;
              this.worklet.port.postMessage({ event: 'ended', t });
            }
          } else {
            if ( viseme !== null && viseme !== PARAMS.MODEL_VISEME_SIL ) {
              this.isSpeaking = true;
              this.worklet.port.postMessage({ event: 'started', t });
            }
          }
          
          // Viseme message
          if ( this.isSpeaking ) {
            let message = {
              event: 'viseme',
              viseme: viseme,
              t: t - this.vectorDuration / 2,
              d: this.vectorDuration
            };
            if ( this.visemeEventsEnabled ) {
              message.vector = v;
              message.distances = distances;
            }
            this.worklet.port.postMessage(message);
          }

        }
        
      }

    }

    // Send downsampled frame
    if ( this.frameEventsEnabled ) {
      const t = this.sampleCount / PARAMS.AUDIO_SAMPLE_RATE; // Seconds
      const frame = new Float32Array(this.ringFrame.count);
      this.ringFrame.getLatest(frame);
      this.worklet.port.postMessage({ event: 'frame', frame, t });
    }
  }

}

export { Processor };
