import * as PARAMS from "./parameters.mjs";
import { RingBuffer } from "./ringbuffer.mjs";

/**
* Gaussian prototype model with Mahalanobis classifier.
* 
* @class 
* @author Mika Suominen
*/
class Classifier {

	/**
	* Creates an instance of the class.
	*
	* @constructor
  * @param {object} [options] Initialization data
	*/
	constructor(options) {

    // Options
    const o = Object.assign({
      silSensitivity: 1.2
    }, options || {});

    // Model, must be loaded separately
    this.prototypes = [];
    this.prototypesN = 0;

    // Pre-allocated diff array and index lookup table
    this.vectorDiff = new Float32Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS);
    this.indexSigmaInvLower = this._buildSigmaInvLowerLookup();

    // Predictions
    this.ringPredictions = new RingBuffer(6, () => PARAMS.MODEL_VISEME_SIL, true);
    this.counts = Array(PARAMS.MODEL_VISEMES_N).fill(0);
    this.predictionLast = PARAMS.MODEL_VISEME_SIL;
    this.silSensitivity = o.silSensitivity;

  }

  // Precompute cos/sin table
  _buildSigmaInvLowerLookup() {
    const lookup = Array.from({ length: PARAMS.MFCC_COEFF_N_WITH_DELTAS }, () => new Uint16Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS));
    let index = 0;
    for (let i = 0; i < PARAMS.MFCC_COEFF_N_WITH_DELTAS; i++) {
      for (let j = 0; j <= i; j++) {
        lookup[i][j] = index;
        lookup[j][i] = index;
        index++;
      }
    }
    return lookup;
  }

  clear() {
    this.prototypes = [];
    this.prototypesN = 0;
  }

  /**
  * Import a new Gaussian prototype model (binary).
  * 
  * @param {Object} data Model event data.
  */
  import(data) {
    
    // Reset?
    if ( data?.reset ) {
      this.clear();
    }

    // Model
    const model = data?.model;
    const N = model?.length || 0;

    // Remove old prototypes
    const groups = [];
    for( let i=0; i<N; i++ ) {
      const p = model[i];
      if ( p.hasOwnProperty("group") ) {
        groups.push(p.group);
      }
    }
    if ( groups.length ) {
      this.prototypes = this.prototypes.filter( x => !groups.includes(x.group) ); 
    }

    // Add new prototypes
    for( let i=0; i<N; i++ ) {
      const p = model[i];
      this.prototypes.push(p);
    }

    // Update model parameters
    this.prototypesN = this.prototypes.length;
    this.distances = Array(this.prototypesN).fill(Infinity);
  }

  /**
  * Update options.
  * 
  * @param {object} options Options
  */
  update(options) {
    for (const name in options) {
      if ( name === "silSentivity" ) {
        const value = options[name];
        this.silSensitivity = value;
      }
    }
  }

  /**
  * Mahalanobis distance for Gaussian prototype.
  * 
  * @param {Float32Array} v Feature vector
  * @param {Float32Array} mu
  * @param {Float32Array} sigmaInvLower
  * @return {number} Mahalanobis distance.
  */
  distanceMahalanobis(v, mu, sigmaInvLower) {

    let d = 0;
    const convert = this.indexSigmaInvLower;
    const diff = this.vectorDiff;

    // Compute diff once
    for (let i = 0; i < PARAMS.MFCC_COEFF_N_WITH_DELTAS; ++i) {
      diff[i] = v[i] - mu[i];
    }

    // Main accumulation loop
    for (let i = 0; i < PARAMS.MFCC_COEFF_N_WITH_DELTAS; ++i) {
      const ii = convert[i][i];
      const diff_i = diff[i];
      let sum = sigmaInvLower[ii] * diff_i * diff_i;

      // Accumulate symmetric cross terms
      for (let j = 0; j < i; ++j) {
        const ij = convert[i][j];
        sum += 2 * sigmaInvLower[ij] * diff_i * diff[j];
      }

      d += sum;
    }

    return d;
  }


	/**
	* Predict the viseme.
	* 
  * NOTE: Distances are rewritten on the subsequent call.
  * 
	* @param {Float32Array} vector Feature vector
	* @return {Object} { viseme, distances }.
	*/
	predict(vector) {

    const N = this.prototypesN;
    
    // If no model, return null
    if ( N === 0 ) {
      return {
        viseme: null,
        distances: []
      };
    }

    // Calculate Mahalanobis distances
    const prototypes = this.prototypes;
    const distances = this.distances;
    let minD = Infinity; // Distance
    let minP = 0; // Prototype  
    for( let i = 0; i < N; i++ ) {
      const p = prototypes[i];
      let d = this.distanceMahalanobis(vector, p.mu, p.sigmaInvLower);

      // Silence sensitivity
      if ( p.viseme === PARAMS.MODEL_VISEME_SIL ) {
        d /= this.silSensitivity;
      }

      distances[i] = d;
      if ( d <= minD ) {
        minD = d;
        minP = i;
      }
    }

    // Majority vote
    const ring = this.ringPredictions;
    const minV = prototypes[ minP ].viseme;
    ring.add( minV );
    const M = ring.capacity;
    const counts = this.counts.fill(0);
    for( let i=0; i<M; i++ ) {
      counts[ring.buf[i]]++;
    }
    let viseme = 0;
    let maxCount = 0;
    for( let i=0; i<PARAMS.MODEL_VISEMES_N; i++ ) {
      const count = counts[i];
      if ( count >= maxCount ) {
        viseme = i;
        maxCount = count;
      }
    }

    // Prediction
    if ( (viseme === this.predictionLast && viseme === PARAMS.MODEL_VISEME_SIL) ) {
      viseme = null;
    } else {
      this.predictionLast = viseme;
    }

    return { viseme, distances };

	}

}

export { Classifier };
