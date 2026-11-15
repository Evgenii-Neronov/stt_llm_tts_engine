class Capture extends AudioWorkletProcessor {
  constructor(){super();this.frames=[];this.count=0;}
  process(inputs){
    const x=inputs[0]?.[0];
    if(x){this.frames.push(x.slice());this.count+=x.length;}
    if(this.count>=sampleRate/25){
      const data=new Float32Array(this.count);let i=0;
      for(const frame of this.frames){data.set(frame,i);i+=frame.length;}
      this.frames=[];this.count=0;this.port.postMessage(data,[data.buffer]);
    }
    return true;
  }
}
registerProcessor('capture',Capture);
