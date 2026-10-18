import * as PARAMS from "./parameters.mjs";

/**
* Voice Active Detection using simple gate model.
*
* @class 
* @author Mika Suominen
*/

class VadGate {

  /**
  * Creates a new instance.
  * 
  * @constructor
  * @param {object} [options] Initial settings
  */
  constructor(options) {

    // Options
    const o = Object.assign({
      vadGateActiveDb: -40,
      vadGateActiveMs: 10,
      vadGateInactiveDb: -50,
      vadGateInactiveMs: 10,
    }, options || {});

    // Settings
    this.activeLE = o.vadGateActiveDb / 10;
    this.activeFrames = Math.max(1, Math.round(
      o.vadGateActiveMs * (PARAMS.AUDIO_SAMPLE_RATE / PARAMS.MFCC_SAMPLES_HOP) / 1000
    ));
    this.inactiveLE = o.vadGateInactiveDb / 10;
    this.inactiveFrames = Math.max(1, Math.round(
      o.vadGateInactiveMs * (PARAMS.AUDIO_SAMPLE_RATE / PARAMS.MFCC_SAMPLES_HOP) / 1000
    ));

    // Counters
    this.active = 0;
    this.inactive = 1;
    this.preActive = 0;
    this.preInactive = 0;

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
        case "vadGateActiveDb":
          this.activeLE = value / 10;
          break;

        case "vadGateActiveMs":
          this.activeFrames = value * (PARAMS.AUDIO_SAMPLE_RATE / PARAMS.MFCC_SAMPLES_HOP) / 1000;
          break;

        case "vadGateInactiveDb":
          this.inactiveLE = value / 10;
          break;

        case "vadGateInactiveMs":
          this.inactiveFrames = value * (PARAMS.AUDIO_SAMPLE_RATE / PARAMS.MFCC_SAMPLES_HOP) / 1000;
          break;
      }
    }
  }

  /**
  * Update VAD statistics for a frame.
  * 
  * @param {number} logEnergy Log energy
  * @return {{active: number, inactive: number}}
  */
  process(le) {

    if ( this.active ) {
      this.active++;

      if ( le < this.inactiveLE ) {
        this.preInactive++;
        if ( this.preInactive >= this.inactiveFrames ) {
          this.active = 0;
          this.inactive = 1;
          this.preActive = 0;
        }
      } else {
        if ( this.preInactive > 0 ) {
          this.preInactive--;
        }
      }

    } else {
      this.inactive++;

      if ( le > this.activeLE ) {
        this.preActive++;
        if ( this.preActive >= this.activeFrames ) {
          this.active = 1;
          this.inactive = 0;
          this.preInactive = 0;
        }
      } else {
        if ( this.preActive > 0 ) {
          this.preActive--;
        }
      }

    }

    return {
      active: this.active, inactive: this.inactive 
    };
  }

}

export { VadGate };
