
// Audio parameters
export const AUDIO_SAMPLE_RATE = 16000; // Sample rate used in downsampling and processing. (16000)
export const AUDIO_DOWNSAMPLE_FILTER_N = 32; // Number of taps per phase
export const AUDIO_DOWNSAMPLE_PHASE_N = 64; // Number of fractional phases
export const AUDIO_PREEMPHASIS_ENABLED = true; // Apply pre-emphasis to boost higher frequencies. (true)
export const AUDIO_PREEMPHASIS_ALPHA = 0.97; // Pre-emphasis alpha. (0.97)

// MFCC parameters
export const MFCC_SAMPLES_N = 512; // Number of samples per feature vector. (512)
export const MFCC_SAMPLES_HOP = 256; // Number of sample hops, If the same as MFCC_SAMPLES_N, no overlap. (256)

export const MFCC_COEFF_N = 12; // The number of MFCC coefficients ignoring log energy c0 and possible deltas. (12)
export const MFCC_MEL_BANDS_N = 40; // The number of Mel bands. (40)
export const MFCC_LIFTER = 22; // Lifter parameter. (22)

export const MFCC_DELTAS_ENABLED = false; // Calculate and include MFCC deltas. (false)
export const MFCC_DELTA_DELTAS_ENABLED = false; // Calculate and include MFCC delta-deltas. Requires that MFCC_DELTAS_ENABLED is true. (false)
export const MFCC_COEFF_N_WITH_DELTAS = MFCC_COEFF_N * (MFCC_DELTAS_ENABLED ? (MFCC_DELTA_DELTAS_ENABLED ? 3 : 2 ) : 1); // Derived constant

export const MFCC_COMPRESSION_ENABLED = true; // If true, apply tanh compression. (true)
export const MFCC_COMPRESSION_TANH_R = 1.0; // Tanh compression range. (1.0)

// Model parameters
export const MODEL_VISEMES_N = 15; // The number of visemes (15)
export const MODEL_VISEME_SIL = 14; // Silence viseme ID (14)

// Binary record, 
// NOTE: Field offsets in bytes and lengths in 32-bit floats
export const RECORD_HEADER_OFFSET = 0;
export const RECORD_HEADER_LEN = 2;
export const RECORD_MU_OFFSET = RECORD_HEADER_LEN * 4;
export const RECORD_MU_LEN = MFCC_COEFF_N_WITH_DELTAS;
export const RECORD_SIGMAINVLOWER_OFFSET = RECORD_MU_OFFSET + RECORD_MU_LEN * 4;
export const RECORD_SIGMAINVLOWER_LEN = MFCC_COEFF_N_WITH_DELTAS * (MFCC_COEFF_N_WITH_DELTAS + 1) / 2;
export const RECORD_OFFSET = RECORD_SIGMAINVLOWER_OFFSET + RECORD_SIGMAINVLOWER_LEN * 4;
export const RECORD_LEN = RECORD_HEADER_LEN + RECORD_MU_LEN + RECORD_SIGMAINVLOWER_LEN;
