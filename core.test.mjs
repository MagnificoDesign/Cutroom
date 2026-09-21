import assert from 'node:assert/strict';import{detectOverlap,frameSimilarity,bestOrder}from'./core.mjs';
const d=(t,x,flat=false)=>({t,mean:flat?0:.4,variance:flat?0:.04,black:flat?1:0,white:0,tile:Array.from({length:48},(_,i)=>flat?0:((i%8)+x)%8/8),edge:Array.from({length:48},(_,i)=>flat?0:(((i%8)+x)%3)/20)});
let A=Array.from({length:30},(_,i)=>d(i*.1,i)),B=Array.from({length:30},(_,i)=>d(i*.1,i+20));let ov=detectOverlap(A,B,{coarseThreshold:.7,denseThreshold:.7,minDuration:.4});assert(ov);assert.notEqual(ov.level,'none');
assert.equal(detectOverlap(Array.from({length:10},(_,i)=>d(i*.1,0,true)),Array.from({length:10},(_,i)=>d(i*.1,0,true))),null);
assert(frameSimilarity(d(0,1),d(0,1))>.9);
assert.deepEqual(bestOrder([{id:'a',samples:A},{id:'b',samples:B}]).sort(),['a','b']);console.log('Cutroom core tests passed');
