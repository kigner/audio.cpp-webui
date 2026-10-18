import * as PARAMS from "./parameters.mjs";

/**
* MIT License
*
* Copyright (c) 2025 Mika Suominen
*
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
*
* The above copyright notice and this permission notice shall be included in all
* copies or substantial portions of the Software.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
* SOFTWARE.
*/

/**
* Calculate mel-frequency cepstral coefficients (MFCC)
*
* @class 
* @author Mika Suominen
*/

class MFCC {

  /**
  * @typedef {Float32Array} Block Block of audio samples
  * @typedef {Float32Array} MFCC MFCC feature vector, 12 features
	*/

  /**
	* Creates an instance of the class.
	*
  * @constructor
	*/
  constructor(options) {

    // Options
    const o = Object.assign({
      speakerMeanHz:150
    }, options || {});

    // FFT
    this.cossin = this._buildCosSin();
    this.bitrev = this._buildBitrev();
    this.spectrum = new Float32Array(2 * PARAMS.MFCC_SAMPLES_N);  // Complex spectrum

    // MFCC
    this.powerSpec = new Float32Array( PARAMS.MFCC_SAMPLES_N / 2);
    this.melFilters = Array.from({ length: PARAMS.MFCC_MEL_BANDS_N }, () => new Float32Array(PARAMS.MFCC_SAMPLES_N / 2) );
    this._buildMelFilterbank(o.speakerMeanHz);
    this.melEnergies = new Float32Array(PARAMS.MFCC_MEL_BANDS_N);
    this.hamming = this._buildWindowHamming();
    this.dctMatrix = this._buildDCTMatrix();
    this.lifter = this._buildLifter();

  }

  // Precompute cos/sin table
  _buildCosSin() {
    const t = new Float32Array(2 * PARAMS.MFCC_SAMPLES_N);
    const theta = (-2 * Math.PI) / PARAMS.MFCC_SAMPLES_N;
    for (let i = 0; i < PARAMS.MFCC_SAMPLES_N; i++) {
      const phase = theta * i;
      t[2 * i] = Math.cos(phase);
      t[2 * i + 1] = Math.sin(phase);
    }
    return t;
  }

  // Precompute bit-reversal indices
  _buildBitrev() {
    const bitrev = new Uint32Array(PARAMS.MFCC_SAMPLES_N);
    const bits = Math.log2(PARAMS.MFCC_SAMPLES_N);
    for (let i = 0; i < PARAMS.MFCC_SAMPLES_N; i++) {
      let j = 0;
      for (let k = 0; k < bits; k++) {
        j = (j << 1) | ((i >> k) & 1);
      }
      bitrev[i] = j;
    }
    return bitrev;
  }

  // Perform in-place radix-2 Cooley–Tukey FFT on real input
  // Note: Includes hamming window
  _hammingAndFFT(realInput) {
    const cossin = this.cossin;
    const bitrev = this.bitrev;
    const hamming = this.hamming;
    const spectrum = this.spectrum;

    // Preload input directly into bit-reversed order
    // Apply hamming window in the same loop
    for (let i = 0; i < PARAMS.MFCC_SAMPLES_N; i++) {
      const idx = bitrev[i];
      spectrum[2 * idx] = realInput[i] * hamming[i];
      spectrum[2 * idx + 1] = 0.0;
    }

    // Iterative radix-2 FFT
    for (let i = 1; i < PARAMS.MFCC_SAMPLES_N; i <<= 1) {
      const step = i << 1;
      const delta = PARAMS.MFCC_SAMPLES_N / step;

      for (let k = 0; k < i; k++) {
        const twBase = 2 * (k * delta);
        const tw_r = cossin[twBase];
        const tw_i = cossin[twBase + 1];

        for (let j = k; j < PARAMS.MFCC_SAMPLES_N; j += step) {
          const i0 = j << 1;
          const i1 = (j + i) << 1;

          const s0_r = spectrum[i0];
          const s0_i = spectrum[i0 + 1];
          const s1_r = spectrum[i1];
          const s1_i = spectrum[i1 + 1];

          const v1_r = s1_r * tw_r - s1_i * tw_i;
          const v1_i = s1_r * tw_i + s1_i * tw_r;

          spectrum[i0] = s0_r + v1_r;
          spectrum[i0 + 1] = s0_i + v1_i;
          spectrum[i1] = s0_r - v1_r;
          spectrum[i1 + 1] = s0_i - v1_i;
        }
      }
    }
  }

  // Pre-compute Hamming window
  _buildWindowHamming() {
    return Float32Array.from({ length: PARAMS.MFCC_SAMPLES_N }, (_, i) =>
      0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (PARAMS.MFCC_SAMPLES_N - 1))
    );
  }

  // Pre-compute Mel filter banks
  _buildMelFilterbank(f0 = 150) {
    const filters = this.melFilters;

    // Reference values
    const f0_ref = 150; // average adult reference
    const warp = Math.min(Math.max(f0 / f0_ref, 0.6), 1.8); // smooth limit

    // Frequency range
    const lowFreq = 30;
    const highFreq = 7800;

    // Mel scale conversion functions
    const mel = f => 2595 * Math.log10(1 + f / 700);
    const melInv = m => 700 * (Math.pow(10, m / 2595) - 1);

    const melLow = mel(lowFreq);
    const melHigh = mel(highFreq);

    // Generate warped mel points
    const melRange = melHigh - melLow;
    const melPoints = Float32Array.from({ length: PARAMS.MFCC_MEL_BANDS_N + 2 }, (_, i) => {
      const m = melLow + (melRange / (PARAMS.MFCC_MEL_BANDS_N + 1)) * i;
      // Warp the mel scale — higher f0 expands, lower compresses
      const mWarped = melLow + (m - melLow) * warp;
      return melInv(mWarped);
    });

    const bin = melPoints.map(f => Math.floor((f / PARAMS.AUDIO_SAMPLE_RATE) * PARAMS.MFCC_SAMPLES_N));

    // Build triangular filters
    for (let i = 0; i < PARAMS.MFCC_MEL_BANDS_N; i++) {
      const fbank = filters[i];
      for (let k = bin[i]; k < bin[i + 1]; k++)
        fbank[k] = (k - bin[i]) / (bin[i + 1] - bin[i]);
      for (let k = bin[i + 1]; k < bin[i + 2]; k++)
        fbank[k] = (bin[i + 2] - k) / (bin[i + 2] - bin[i + 1]);
    }
  }

  // Precompute DCT matrix
  _buildDCTMatrix() {
    const mat = [];
    const scale = Math.sqrt(2 / PARAMS.MFCC_MEL_BANDS_N);
    for (let i = 0; i <= PARAMS.MFCC_COEFF_N; i++) {
      const row = new Float32Array(PARAMS.MFCC_MEL_BANDS_N);
      for (let j = 0; j < PARAMS.MFCC_MEL_BANDS_N; j++) {
        row[j] = scale * Math.cos((Math.PI * i * (j + 0.5)) / PARAMS.MFCC_MEL_BANDS_N);
      }
      mat.push(row);
    }
    return mat;
  }

  // Pre-compute lifter coefficients, C0 skipped
  _buildLifter() {
    const lifter = new Float32Array(PARAMS.MFCC_COEFF_N);
    for (let i = 1; i <= PARAMS.MFCC_COEFF_N; i++) {
      lifter[i-1] = 1 + (PARAMS.MFCC_LIFTER / 2) * Math.sin((Math.PI * i) / PARAMS.MFCC_LIFTER);
    }
    return lifter;
  }

  /**
  * Update options.
  * 
  * @param {object} options Options
  */
  update(options) {
    for (const name in options) {
      if ( name === "speakerMeanHz" ) {
        const value = options[name];
        this._buildMelFilterbank(value);
      }
    }
  }

  /**
	* Compute MFCC feature vector.
	* 
	* @param {Block} block Sample block
  * @param {MFCC} [out] Pre-allocated MFCC feature vector (12 features, excluding log energy)
	* @return {Object} Log energy and the mfcc feature vector { le, mfcc }
	*/
  compute(block, out) {

    const N2 = PARAMS.MFCC_SAMPLES_N / 2;

    // Hamming window + FFT, output will be in this.spectrum
    this._hammingAndFFT(block);

    // Compute power spectrum (first N/2 bins)
    const spectrum = this.spectrum;
    const power = this.powerSpec;
    let totalEnergy = 0;
    for (let k = 0; k < N2; k++) {
      const re = spectrum[2 * k];
      const im = spectrum[2 * k + 1];
      power[k] = (re * re + im * im) / PARAMS.MFCC_SAMPLES_N; // Note: normalize by N
      totalEnergy += power[k];
    }

    // Log energy
    const le = Math.log10(totalEnergy + 1e-10);

    // Apply Mel filters
    const filters = this.melFilters;
    const energies = this.melEnergies;
    for (let m = 0; m < PARAMS.MFCC_MEL_BANDS_N; m++) {
      const f = filters[m];
      const len = f.length;
      let sum = 0;
      for (let k = 0; k < len; k++) {
        sum += power[k] * f[k];
      }
      energies[m] = Math.log10(sum + 1e-10);
    }

    // DCT + lifter to MFCC feature vector
    const dct = this.dctMatrix;
    const mfcc = out || new Float32Array(PARAMS.MFCC_COEFF_N);
    const lifter = this.lifter;
    for (let i = 0; i < PARAMS.MFCC_COEFF_N; i++) {
      const row = dct[i+1];
      let sum = 0;
      for (let j = 0; j < PARAMS.MFCC_MEL_BANDS_N; j++) {
        sum += row[j] * energies[j];
      }
      mfcc[i] = sum * lifter[i];
    }

    return { le, mfcc };
  }

}

export { MFCC };
