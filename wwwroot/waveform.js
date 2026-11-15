export class Waveform {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.line = getComputedStyle(canvas).color;
    new ResizeObserver(() => {
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
      this.draw(this.samples);
    }).observe(canvas);
  }

  draw(samples = null) {
    this.samples = samples;
    const {width, height} = this.canvas;
    const ink = this.context;
    const middle = height / 2;
    ink.clearRect(0, 0, width, height);
    ink.strokeStyle = '#304451';
    ink.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    ink.beginPath();
    ink.moveTo(0, middle);
    ink.lineTo(width, middle);
    ink.stroke();
    if (!samples?.length) return;

    const columns = Math.min(180, samples.length, width);
    ink.strokeStyle = this.line;
    ink.beginPath();
    for (let column = 0; column < columns; column++) {
      const first = Math.floor(column * samples.length / columns);
      const end = Math.floor((column + 1) * samples.length / columns);
      let low = samples[first];
      let high = low;
      for (let i = first + 1; i < end; i++) {
        low = Math.min(low, samples[i]);
        high = Math.max(high, samples[i]);
      }
      const x = column * width / columns;
      const top = middle - Math.min(1, high) * middle * .94;
      const bottom = middle - Math.max(-1, low) * middle * .94;
      ink.moveTo(x, top);
      ink.lineTo(x, Math.max(bottom, top + 1));
    }
    ink.stroke();
  }
}
