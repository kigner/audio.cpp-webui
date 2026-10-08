import { Processor } from "./processor.mjs";

/**
* Audio processor for handling audio-driven viseme detection.
* 
* @class 
* @extends AudioWorkletProcessor
* @author Mika Suominen
*/
export class HeadWorklet extends AudioWorkletProcessor {

  /**
  * Creates a new instance of the audio processor.
  * 
  * @constructor
  * @param {object} [options] Optional initialization data.
  * @param {object} [options.processorOptions] Custom options passed from the AudioWorkletNode.
  */
  constructor(options) {
    super(options);

    // Options
    options = options || {};
    options.sampleRate = sampleRate;
    this.detectors = {}; // Option change detector
    for (const desc of HeadWorklet.parameterDescriptors) {
      const name = desc.name;
      const value = desc.value
      this.detectors[name] = value;
      options[name] = value;
    }

    // Processor
    this.processor = new Processor(options, this);

    // Message handler
    this.port.onmessage = this.processor._onmessage.bind(this.processor);

  }


  /**
  * Called by the AudioWorklet to process audio data.
  *
  * @param {Float32Array[][]} inputs Multichannel input arrays.
  * @param {Float32Array[][]} outputs Multichannel output arrays
  * @param {Record<string, Float32Array>} parameters Current parameter values.
  * @return {boolean} If true, keep processing, otherwise stop
  */
  process(inputs, outputs, parameters) {

    // Sample data
    const input = inputs[0];
    if ( !input ) return true;
    const data = input[0];
    if ( !data ) return true;
    const M = data.length;
    if ( !M ) return true;

    // Detect audio parameter changes
    const detectors = this.detectors;
    let changed = false;
    const options = {};

    for (const name in parameters) {
      const arr = parameters[name];
      const newValue = arr[0];
      const oldValue = detectors[name];

      if (newValue !== oldValue) {
        changed = true;
        detectors[name] = options[name] = newValue;
      }
    }

    // Apply changed
    if ( changed ) {
      this.processor.update(options);
    }

    // Process mono audio data
    this.processor.process(data);

    return true;
  }

  /**
  * Define parameter descriptors for automation and configuration.
  * 
  * @returns {Array<AudioParamDescriptor>} List of parameter descriptors.
  */
  static get parameterDescriptors() {
    return [
      { name: 'timerReset', defaultValue: -9999, automationRate: 'k-rate' },
      { name: "vadMode", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "vadGateActiveDb", defaultValue: -40, minValue: -100, maxValue: 0, automationRate: "k-rate" },
      { name: "vadGateActiveMs", defaultValue: 10, minValue: 0, maxValue: 1000, automationRate: "k-rate" },
      { name: "vadGateInactiveDb", defaultValue: -50, minValue: -100, maxValue: 0, automationRate: "k-rate" },
      { name: "vadGateInactiveMs", defaultValue: 10, minValue: 0, maxValue: 1000, automationRate: "k-rate" },
      { name: "silMode", defaultValue: 1, minValue: 0, maxValue: 2, automationRate: "k-rate" },
      { name: "silCalibrationWindowSec", defaultValue: 3.0, minValue: 0.1, maxValue: 10, automationRate: "k-rate" },
      { name: "silSensitivity", defaultValue: 1.2, minValue: 0, maxValue: 4, automationRate: "k-rate" },
      { name: "speakerMeanHz", defaultValue: 150, minValue: 50, maxValue: 500, automationRate: "k-rate" }
    ];
  }

}

registerProcessor("headworklet", HeadWorklet);
