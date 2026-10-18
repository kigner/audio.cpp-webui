import * as PARAMS from "./parameters.mjs";

/**
* Gaussian prototype model with Mahalanobis classifier.
* 
* @class 
* @author Mika Suominen
*/
class Training {

	/**
	* Creates an instance of the class.
	*
	* @constructor
  * @param {object} [options] Initialization data
	*/
	constructor(options) {

    // Options
    const o = Object.assign({
    }, options || {});

    // Pre-allocated arrays and index lookup tables
    this.vectorDiff = new Float32Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS);
    this.matrixL = Array.from({ length: PARAMS.MFCC_COEFF_N_WITH_DELTAS }, () => new Float32Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS) ); // Cholesky Decomposition
    this.matrixLInv = Array.from({ length: PARAMS.MFCC_COEFF_N_WITH_DELTAS }, () => new Float32Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS) ); // Cholesky Inverse
    this.matrixSigma = Array.from({ length: PARAMS.MFCC_COEFF_N_WITH_DELTAS }, () => new Float32Array(PARAMS.MFCC_COEFF_N_WITH_DELTAS) ); // sigmaInv
    this.indexSigmaInvLower = this._buildSigmaInvLowerLookup();

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

  /**
  * Calculate Gaussian prototype and its binary representation.
  * 
  * @param {string} phoneme IPA phoneme, 0-2 BPM characters
  * @param {number} group Group ID
  * @param {number} viseme Viseme ID
  * @param {Float32Array[]} vs Feature vectors
  * @return {Object} Gaussian prototype { mu, sigmaInv, sigmaInvLower, bin }
  */
  computePrototype(phoneme, group, viseme, vs) {

    const N = PARAMS.MFCC_COEFF_N_WITH_DELTAS;
    const M = vs.length;
    if (M < N) {
      throw new Error(`Not enough samples (${M}) to compute full covariance.`);
    }

    // Model
    const record = new Float32Array(PARAMS.RECORD_LEN);
    const view = new DataView(record.buffer, PARAMS.RECORD_HEADER_OFFSET, PARAMS.RECORD_HEADER_LEN * 4);
    const ph1 = phoneme?.codePointAt(0) || 0;
    const ph2 = phoneme?.codePointAt(1) || 0;
    const phPacked = (ph1 << 16) | (ph2 || 0);
    view.setUint32(PARAMS.RECORD_HEADER_OFFSET, phPacked)
    view.setUint8(PARAMS.RECORD_HEADER_OFFSET + 5, group);
    view.setUint8(PARAMS.RECORD_HEADER_OFFSET + 7, viseme);
    const mu = new Float32Array( record.buffer, PARAMS.RECORD_MU_OFFSET, PARAMS.RECORD_MU_LEN );
    const sigmaInvLower = new Float32Array( record.buffer, PARAMS.RECORD_SIGMAINVLOWER_OFFSET, PARAMS.RECORD_SIGMAINVLOWER_LEN );

    // Accumulate column sums and means
    for (let k = 0; k < M; k++) {
      const row = vs[k];
      for (let i = 0; i < N; i++) {
        mu[i] += row[i];
      }
    }
    const invM = 1 / M;
    for (let i = 0; i < N; i++) {
      mu[i] *= invM;
    }

    // Calculate covariance matrix
    const sigma = this.matrixSigma;
    sigma.forEach( x => x.fill(0) );
    const invM2 = 1 / (M - 1);
    for (let k = 0; k < M; k++) {
      const row = vs[k];
      for (let i = 0; i < N; i++) {
        const di = row[i] - mu[i];
        for (let j = i; j < N; j++) {
          sigma[i][j] += di * (row[j] - mu[j]);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        const v = sigma[i][j] * invM2;
        sigma[i][j] = v;
        if ( i !== j ) sigma[j][i] = v;
      }
    }

    // Numerical stabilization
    let trace = 0;
    for (let i = 0; i < N; i++) {
      trace += sigma[i][i];
    }
    const baseJitter = (trace / N) * 1e-5;
    for (let i = 0; i < N; i++) {
      sigma[i][i] += baseJitter;
    }

    // Calculate Cholesky Decomposition
    const L = this.matrixL;
    L.forEach( x => x.fill(0) );
    for (let i = 0; i < N; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = sigma[i][j];
        for (let k = 0; k < j; k++) {
          sum -= L[i][k] * L[j][k];
        }
        if (i === j) {
          if (sum <= 0) throw new Error(`Matrix is not positive definite.`);
          L[i][j] = Math.sqrt(sum);
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }

    // Cholesky Inverse using lower triangular matrix
    const LInv = this.matrixLInv;
    LInv.forEach( x => x.fill(0) );
    for (let i = 0; i < N; i++) {
      LInv[i][i] = 1 / L[i][i];
      for (let j = 0; j < i; j++) {
        let sum = 0;
        for (let k = j; k < i; k++) {
          sum -= L[i][k] * LInv[k][j];
        }
        LInv[i][j] = sum / L[i][i];
      }
    }

    // Covariance inverse sigmaInv = inv(L^T) * inv(L)
    const sigmaInv = Array.from({ length: N}, () => new Float32Array(N) );
    let pos = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = 0;
        for (let k = Math.max(i, j); k < N; k++) {
          if (k >= i && k >= j) sum += LInv[k][i] * LInv[k][j];
        }
        sigmaInv[i][j] = sum;
        sigmaInv[j][i] = sum; // ensure symmetry
        sigmaInvLower[pos] = sum; // Model
        pos++;
      }
    }

    return { mu, sigmaInv, sigmaInvLower, bin: record.buffer };
  }

  /**
  * Decode binary record.
  * 
  * @param {TypedArray} record Record view
  * @return {Object} Prototype record { viseme, group, mu, sigmaInvLower }
  */
  decodeBinaryRecord(record) {
    const header = new DataView(record.buffer,record.byteOffset,PARAMS.RECORD_HEADER_LEN * 4);
    const phPacked = header.getUint32(PARAMS.RECORD_HEADER_OFFSET);
    const ph1 = phPacked >>> 16;
    const ph2  = phPacked & 0xFFFF;
    const phoneme = (ph2 === 0) ? String.fromCodePoint(ph1) : String.fromCodePoint(ph1, ph2);
    const group = header.getUint8(PARAMS.RECORD_HEADER_OFFSET + 5);
    const viseme = header.getUint8(PARAMS.RECORD_HEADER_OFFSET + 7);
    const mu = new Float32Array(record.buffer, record.byteOffset + PARAMS.RECORD_MU_OFFSET, PARAMS.RECORD_MU_LEN);
    const sigmaInvLower = new Float32Array(record.buffer, record.byteOffset + PARAMS.RECORD_SIGMAINVLOWER_OFFSET, PARAMS.RECORD_SIGMAINVLOWER_LEN);
    return { phoneme, group, viseme, mu, sigmaInvLower };
  }

  /**
  * Decode binary record.
  * 
  * @param {string} location URL or path to .bin model file
  * @param {number} [group=null] Override group id
  * @return {Object[]} Array of prototype records { viseme, group, mu, sigmaInvLower }.
  */
  async loadModel(location, group=null) {

    // Load file
    const response = await fetch(location);
    if (!response.ok) {
      throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();

    // Extract records
    const model = [];
    const len = buffer.byteLength;
    let pos = 0;
    while( (pos + PARAMS.RECORD_OFFSET) <= len ) {
      const record = new Float32Array(buffer, pos, PARAMS.RECORD_LEN);
      const p = this.decodeBinaryRecord(record);
      if ( group !== null ) {
        p.group = group;
      }
      model.push(p);
      pos += PARAMS.RECORD_OFFSET;
    }

    // Check
    if ( model.length === 0 ) {
      throw new Error("Fetched model is empty");
    }

    return { model, buffer };
  }

  /**
  * Update options.
  * 
  * @param {object} options Options
  */
  update(options) {
    for (const name in options) {
      // TODO
    }
  }

}

export { Training };
