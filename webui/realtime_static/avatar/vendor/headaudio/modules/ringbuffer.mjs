
/**
* Fixed-size ring buffer.
*
* @class 
* @author Mika Suominen
*/
class RingBuffer {

  /**
  * Create a new RingBuffer of given capacity.
  * 
  * @constructor
  * @param {number} capacity Maximum number of items the buffer can hold
  * @param {function} [fn=undefined] Populate items
  * @param {function} [full=false] If true, init as full.
  */
  constructor(capacity, fn=undefined, full=false) {
    
    this.buf = Array.from({ length: capacity }, fn );
    
    this.capacity = capacity;
    this.head = 0; // Index of oldest element
    this.tail = 0; // Index of next write
    this.count = full ? capacity : 0; // Number of valid elements
  }

  /**
   * Add item.
   * 
   * @param {any} item
   */
  add(item) {
    const c = this.capacity;
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % c;

    if (this.count < c) {
      this.count++;
    } else {
      this.head = (this.head + 1) % c;
    }
  }

  /**
   * Allocate the next item and advance.
   * 
   * @return {any} Reference to the new allocated item.
   */
  allocate() {
    const c = this.capacity;
    const item = this.buf[this.tail];
    this.tail = (this.tail + 1) % c;

    if (this.count < c) {
      this.count++;
    } else {
      this.head = (this.head + 1) % c;
    }

    return item;
  }

  /**
   * Check if at least N unread (latest) items are available
   * since the last successful `getLatestN()` call.
   *
   * @param {number} N Number of items to check for availability
   * @returns {boolean} If `true`, N items are available.
   */
  isAvailable(N) {
    return this.count >= N;
  }

  /**
   * Check if the ring buffer is full.
   *
   * @returns {boolean} If `true`, the buffer is full.
   */
  isFull() {
    return this.count === this.capacity;
  }

  /**
   * Get reference to the first item.
   *
   * @param {number} [pos=0] Position relative to the head
   * @return {any} Item.
   */
  getHead(pos=0) {
    const c = this.capacity;
    const index = (this.head + (pos % c) + c) % c;
    return this.buf[index];
  }

  /**
   * Get reference to the last item.
   *
   * @param {number} [pos=0] Position relative to the tail
   * @return {any} Item.
   */
  getTail(pos=0) {
    const c = this.capacity;
    const index = (this.tail + ((pos-1) % c) + c) % c;
    return this.buf[index];
  }

  /**
   * Copy the latest items into a provided pre-allocated buffer.
   * The number of items to fetch is (out.length). After reading,
   * the count of valid items will be (out.length - hop).
   *
   * @param {any[]} out Preallocated array to fill with items
   * @param {number} [hop=null] Hop size [0,out.length]. If null, don't update status.
   * @return {any[]|null} Input array of null if not enough items.
   */
  getLatest(out, hop=null) {
    const N = out.length;
    if ( N > this.count ) return null;

    // Calculate the starting index
    const c = this.capacity;
    this.head = (this.head + (this.count - N) ) % c;
    for (let i = 0; i < N; i++) {
      const idx = (this.head + i) % c;
      out[i] = this.buf[idx];
    }

    // Update status
    if ( hop !== null && hop >= 0 && hop <= N ) { 
      this.head = (this.head + hop ) % c;
      this.count = N - hop;
    }

    return out;
  }

  /**
  * Clear the buffer.
  * 
  * @param {number} [cnt=0] Number of items to leave.
  */
  clear( cnt = 0 ) {
    this.count = cnt;
    this.tail = (this.head + cnt) % this.capacity;
  }

}

export { RingBuffer };
