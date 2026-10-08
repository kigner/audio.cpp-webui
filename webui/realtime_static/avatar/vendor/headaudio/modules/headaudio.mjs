import * as PARAMS from "./parameters.mjs";
import { Training } from "./training.mjs";

/**
* Audio worklet node for handling audio-driven viseme detection.
* 
* @class 
* @extends AudioWorkletNode
* @author Mika Suominen
*/
class HeadAudio extends AudioWorkletNode {

  /**
  * Creates a new instance of the audio processor.
  * 
  * @constructor
  * @param {object} [options] Optional initialization dat
  * @param {object} [options.processorOptions] Custom options passed from the AudioWorkletNode
  * @param {object} [options.parameterData] Custom parameter data.
  */
  constructor(audioCtx, options = null) { 

    // Default values (for future use)
    const o = Object.assign({
    }, options || {});

    // NOTE: Always take mono in, no outputs
    super(audioCtx, "headworklet", {

      numberOfInputs: 1, // Only one input allowed
      numberOfOutputs: 0, // One outputs, for testing only
      channelCount: 1, // Mono input
      channelCountMode: 'explicit', // Only mono input
      channelInterpretation: 'speakers', // Down-mix properly to mono
      outputChannelCount: [], // No outputs
      
      processorOptions: o?.processorOptions || {},
      parameterData: o?.parameterData || {}

    });

    this.frameEventsEnabled = !!o.processorOptions?.frameEventsEnabled;
    this.vadEventsEnabled = !!o.processorOptions?.vadEventsEnabled;
    this.featureEventsEnabled = !!o.processorOptions?.featureEventsEnabled;
    this.visemeEventsEnabled = !!o.processorOptions?.visemeEventsEnabled;

    // Visemes
    this.visemeNames = [
      'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U',
      'viseme_PP', 'viseme_SS', 'viseme_TH', 'viseme_DD', 'viseme_FF',
      'viseme_kk', 'viseme_nn', 'viseme_RR', 'viseme_CH', 'viseme_sil'
    ];
    this.nVisemes = this.visemeNames.length;
    this.visemeMaxs = [
      0.65, 0.65, 0.65, 0.65, 0.65,
      0.75, 0.65, 0.65, 0.65, 0.75,
      0.65, 0.65, 0.65, 0.65, 0.65
    ];
    this.visemeAlphas = new Array( this.nVisemes ).fill(0);
    this.visemeActive = -1;
    this.easing = this.sigmoidFactory(5);

    // Class events
    this.onvalue = null;
    this.onframe = null;
    this.onsentence = null;
    this.onstarted = null;
    this.onended = null;
    this.onfeature = null;
    this.onviseme = null;

    // On-line training
    this.training = new Training();

    // Timer
    this.timerCounter = 0;
    this.isRunning = true;

    // Set event handler
    this.port.onmessage = this._onmessage.bind(this);

  }

  /**
  * Create a sigmoid function.
  * 
  * @param {number} k Sharpness of ease.
  * @return {function} Sigmoid function.
  */
  sigmoidFactory(k) {
    function base(t) { return (1 / (1 + Math.exp(-k * t))) - 0.5; }
    var corr = 0.5 / base(1);
    return function (t) { return corr * base(2 * Math.max(Math.min(t, 1), 0) - 1) + 0.5; };
  }

  /**
  * Event handler
  * 
  * @param {Object} message Message from processor.
  */
  _onmessage(message) {
    const data = message.data;

    switch (data.event) {
      case 'frame':
        if ( this.frameEventsEnabled && this.onframe && typeof this.onframe === 'function' ) {
          this.onframe(data);
        }
        break;

      case 'vad':
        if ( this.vadEventsEnabled && this.onvad && typeof this.onvad === 'function' ) {
          this.onvad(data);
        }
        break;

      case 'feature':
        if ( this.featureEventsEnabled && this.onfeature && typeof this.onfeature === 'function' ) {
          this.onfeature(data);
        }
        break;

      case 'viseme':
        const viseme = data.viseme;
        if ( Number.isInteger(viseme) && viseme >= 0 && viseme < this.nVisemes ) {
          if ( viseme === PARAMS.MODEL_VISEME_SIL ) {
            this.visemeActive = -1;
          } else {
            this.visemeActive = viseme;
          }
        }
        if ( this.visemeEventsEnabled && this.onviseme && typeof this.onviseme === 'function' ) {
          this.onviseme(data);
        }
        break;

      case 'started':
        if ( this.onstarted && typeof this.onstarted === 'function' ) {
          this.onstarted(data);
        }
        break;
        
      case 'ended':
        this.visemeActive = -1;
        this.lastEndEvent = performance.now();
        if ( this.onended && typeof this.onended === 'function' ) {
          this.onended(data);
        }
        break;

      case 'calibrated':
        try {
          const { mu, sigmaInvLower, bin } = this.training.computePrototype("sc", 255, PARAMS.MODEL_VISEME_SIL, data.vs);
          this.port.postMessage({ event: "model", model: [{
            phoneme: "sc", group: 255, viseme: PARAMS.MODEL_VISEME_SIL, mu, sigmaInvLower
          }] }, [bin]);
        } catch(error) { 
          data.error = error;
          console.error(error);
        }
        if ( this.oncalibrated && typeof this.oncalibrated === 'function' ) {
          this.oncalibrated(data);
        }
        break;
    }
  }

  /**
  * Load a pre-trained binary viseme model.
  * 
  * @param {string} url URL for the binary file
  * @param {boolean} [reset=true] If true, reset all previous models.
  */
  async loadModel(url, reset=true) {
    const { model, buffer } = await this.training.loadModel(url);
    if ( reset ) {
      this.port.postMessage({ event: "reset" });
    }
    this.port.postMessage({ event: "model", model }, [buffer]);
  }

  /**
  * Viseme animation method.
  * 
  * @param {number} dt Delta time in milliseconds.
  */
  update(dt) {
    const da = dt / 100;

    for( let i=0; i<this.nVisemes; i++ ) {

      // Update
      let alpha = this.visemeAlphas[i];
      let changed = false;
      if ( i === this.visemeActive ) {
        changed = true;
        if ( alpha < 1 ) {
          alpha += da;
          if ( alpha > 0.99 ) {
            alpha = 1;
          }
        }
      } else {
        if ( alpha > 0 ) {
          changed = true;
          alpha -= da;
          if ( alpha < 0.01 ) {
            alpha = 0;
          }
        }
      }

      // If value changed, apply callback
      if ( changed ) {
        let val = this.visemeMaxs[i] * this.easing( alpha );
        if ( this.onvalue && typeof this.onvalue === "function" ) {
          this.onvalue( this.visemeNames[i], val );
        }
        this.visemeAlphas[i] = alpha;
      }
    }

  }

  /**
  * Start.
  */
  start() {
    this.isRunning = true;
    this.port.postMessage({ event: "start" });
  }

  /**
  * Stop.
  */
  stop() {
    this.isRunning = false;
    this.port.postMessage({ event: "stop" });
  }

  /**
  * Stop.
  */
  calibrate() {
    this.port.postMessage({ event: "calibrate" });
  }

  /**
  * Reset processor.
  */
  resetAll() {
    this.port.postMessage({ event: "reset" });
  }

  /**
  * Reset processor.
  */
  resetTimer() {
    this.timerCounter++;
    this.parameters.get("timerReset").value = this.timerCounter;
  }

  

}

export { HeadAudio };