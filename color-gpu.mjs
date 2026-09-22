import { readHdr, paintSample, resolveColor } from './color.mjs?v=15';
import { isHdr } from './quality.mjs?v=15';

const vertex = `#version 300 es
out vec2 uv;
void main(){vec2 p=vec2(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0);uv=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0,1);}`;
const fragment = `#version 300 es
precision highp float;
precision highp usampler2D;
in vec2 uv;out vec4 result;
uniform usampler2D planeY,planeU,planeV;
uniform vec4 fit,visible;
uniform vec2 subsample,coefficients;
uniform vec4 ranges;
uniform int rotation,flipped,interleaved,transfer,primaries;
float readPlane(usampler2D t,vec2 p,int c){
 ivec2 sz=textureSize(t,0);p=clamp(p,vec2(0),vec2(sz-1));ivec2 a=ivec2(floor(p)),b=min(a+1,sz-1);vec2 f=fract(p);
 return mix(mix(float(texelFetch(t,a,0)[c]),float(texelFetch(t,ivec2(b.x,a.y),0)[c]),f.x),mix(float(texelFetch(t,ivec2(a.x,b.y),0)[c]),float(texelFetch(t,b,0)[c]),f.x),f.y);
}
vec3 inverseCurve(vec3 v){v=clamp(v,0.0,1.0);if(transfer==0){vec3 p=pow(v,vec3(32.0/2523.0));return 10000.0*pow(max(p-3424.0/4096.0,0.0)/(2413.0/128.0-2392.0/128.0*p),vec3(16384.0/2610.0));}
 vec3 lo=v*v/3.0,hi=(exp((v-.55991073)/.17883277)+.28466892)/12.0;vec3 linear=mix(hi,lo,lessThanEqual(v,vec3(.5)));return linear*1000.0*pow(max(dot(linear,vec3(.2627,.678,.0593)),0.0),.2);
}
void main(){
 vec2 p=(uv-fit.xy)/fit.zw;if(any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1)))){result=vec4(0,0,0,1);return;}
 if(flipped==1)p.x=1.0-p.x;
 if(rotation==90)p=vec2(p.y,1.0-p.x);else if(rotation==180)p=1.0-p;else if(rotation==270)p=vec2(1.0-p.y,p.x);
 p=visible.xy+p*visible.zw-.5;vec2 cp=(p+.5)/subsample-.5;
 float y=(readPlane(planeY,p,0)-ranges.x)/ranges.y;
 float u=(readPlane(planeU,cp,0)-ranges.z)/ranges.w;
 float v=((interleaved==1?readPlane(planeU,cp,1):readPlane(planeV,cp,0))-ranges.z)/ranges.w;
 float r=y+2.0*(1.0-coefficients.x)*v,b=y+2.0*(1.0-coefficients.y)*u;
 vec3 rgb=inverseCurve(vec3(r,(y-coefficients.x*r-coefficients.y*b)/(1.0-coefficients.x-coefficients.y),b));
 if(primaries==1)rgb=vec3(dot(rgb,vec3(1.660491,-.587641,-.07285)),dot(rgb,vec3(-.12455,1.1329,-.008349)),dot(rgb,vec3(-.018151,-.100579,1.11873)));
 float lum=max(dot(rgb,vec3(.2126,.7152,.0722))/203.0,0.0);
 float mapped=lum<=.75?lum:.75+.25*(lum-.75)/(lum-.5);rgb*=lum>1e-9?mapped/(lum*203.0):0.0;
 float sat=1.0;for(int c=0;c<3;c++){if(rgb[c]<0.0)sat=min(sat,mapped/(mapped-rgb[c]));if(rgb[c]>1.0)sat=min(sat,(1.0-mapped)/(rgb[c]-mapped));}
 rgb=clamp(mapped+(rgb-mapped)*sat,0.0,1.0);rgb=mix(1.055*pow(rgb,vec3(1.0/2.4))-.055,12.92*rgb,lessThanEqual(rgb,vec3(.0031308)));
 result=vec4(clamp(rgb,0.0,1.0),1);
}`;

// GPU resources belong to this render/inspection job and are explicitly freed.
// No source pictures, color maps, canvases or textures survive in a global cache.
export function createPainter(target, { fit = 'contain' } = {}) {
  let gl, canvas, program, textures = [], shaders = [], unavailable = false;
  function dispose() {
    if (gl) {
      for (const texture of textures) gl.deleteTexture(texture);
      for (const shader of shaders) gl.deleteShader(shader);
      if (program) gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    gl = canvas = program = null; textures = []; shaders = [];
  }
  function init() {
    canvas = document.createElement('canvas'); canvas.width = target.width; canvas.height = target.height;
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('No local color shader');
    gl.drawingBufferColorSpace = 'srgb';
    program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type); shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Color shader could not start');
    textures = [0, 1, 2].map(() => gl.createTexture());
    gl.useProgram(program); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const [i, name] of ['planeY', 'planeU', 'planeV'].entries()) gl.uniform1i(gl.getUniformLocation(program, name), i);
  }
  async function paint(sample, signal, color = sample.colorSpace) {
    signal?.throwIfAborted();
    color = resolveColor(color, sample.colorSpace);
    if (!isHdr(color) || unavailable) return paintSample(sample, target, signal, color, fit);
    try { if (!gl) init(); }
    catch { dispose(); unavailable = true; return paintSample(sample, target, signal, color, fit); }
    const raw = await readHdr(sample, signal, color), p = raw.format;
    signal?.throwIfAborted();
    if (gl.isContextLost()) { dispose(); unavailable = true; return paintSample(sample, target, signal, color, fit); }
    gl.useProgram(program); gl.viewport(0, 0, target.width, target.height);
    for (let i = 0; i < 3; i++) {
      const plane = p.interleaved && i === 2 ? 1 : i, channels = p.interleaved && plane ? 2 : 1;
      const w = plane ? Math.ceil(raw.width / p.sx) : raw.width, h = plane ? Math.ceil(raw.height / p.sy) : raw.height;
      gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, raw.layout[plane].stride / p.bytes / channels);
      const data = p.bytes === 2 ? new Uint16Array(raw.bytes.buffer, raw.layout[plane].offset) : raw.bytes.subarray(raw.layout[plane].offset);
      gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG8UI : p.bytes === 2 ? gl.R16UI : gl.R8UI,
        w, h, 0, channels === 2 ? gl.RG_INTEGER : gl.RED_INTEGER, p.bytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE, data);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    const scale = Math.min(target.width / sample.displayWidth, target.height / sample.displayHeight), w = fit === 'fill' ? 1 : sample.displayWidth * scale / target.width, h = fit === 'fill' ? 1 : sample.displayHeight * scale / target.height;
    const rect = sample.visibleRect, factor = 2 ** (p.depth - 8), maximum = 2 ** p.depth - 1, full = raw.color.fullRange === true;
    const uniform = (name, kind, ...values) => gl[kind](gl.getUniformLocation(program, name), ...values);
    uniform('fit', 'uniform4f', (1 - w) / 2, (1 - h) / 2, w, h);
    uniform('visible', 'uniform4f', rect.left, rect.top, rect.width, rect.height);
    uniform('subsample', 'uniform2f', p.sx, p.sy);
    uniform('ranges', 'uniform4f', full ? 0 : 16 * factor, full ? maximum : 219 * factor, 128 * factor, full ? maximum : 224 * factor);
    uniform('coefficients', 'uniform2f', ...(raw.color.matrix === 'bt2020-ncl' ? [.2627, .0593] : [.2126, .0722]));
    for (const [name, value] of Object.entries({ rotation: sample.rotation || 0, flipped: Number(!!sample.flip), interleaved: Number(p.interleaved), transfer: raw.color.transfer === 'pq' ? 0 : 1, primaries: raw.color.primaries === 'bt2020' ? 1 : 0 })) uniform(name, 'uniform1i', value);
    gl.drawArrays(gl.TRIANGLES, 0, 3); gl.flush();
    if (gl.getError() !== gl.NO_ERROR) { dispose(); unavailable = true; return paintSample(sample, target, signal, color, fit); }
    signal?.throwIfAborted();
    target.getContext('2d', { alpha: false, colorSpace: 'srgb' }).drawImage(canvas, 0, 0);
    return true;
  }
  return { paint, dispose, get accelerated() { return !!gl; } };
}
