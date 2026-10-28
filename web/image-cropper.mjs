// Device-local crop UI. Keeps source bytes so a saved crop can be adjusted again.
export function cropOutputOptions({maxOutputSize=1920,outputType='image/png',outputQuality=.92,maxOutputBytes=Infinity}={}){
  if(!Number.isInteger(maxOutputSize)||maxOutputSize<1||maxOutputSize>1920||!['image/png','image/jpeg','image/webp'].includes(outputType)||!Number.isFinite(outputQuality)||outputQuality<.1||outputQuality>1||!(maxOutputBytes===Infinity||Number.isSafeInteger(maxOutputBytes)&&maxOutputBytes>0))throw new Error('图片输出设置无效。');
  return {maxOutputSize,outputType,outputQuality,maxOutputBytes};
}

export async function encodeCropCanvas(canvas,options={},cancelled=()=>false){
  const {outputType,outputQuality,maxOutputBytes}=cropOutputOptions(options),qualities=[outputQuality];
  if(outputType!=='image/png'&&Number.isFinite(maxOutputBytes)){
    for(let percent=Math.round(outputQuality*100)-10;percent>22;percent-=10)qualities.push(percent/100);
    if(outputQuality>.22)qualities.push(.22);
  }
  for(const quality of qualities){
    if(cancelled())throw new DOMException('已取消图片处理。','AbortError');
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,outputType,quality));
    if(cancelled())throw new DOMException('已取消图片处理。','AbortError');
    if(!blob)throw new Error('图片无法保存，请重试。');
    if(blob.type!==outputType)throw new Error('此设备无法保存所需图片格式。');
    if(blob.size<=maxOutputBytes)return blob;
  }
  throw new Error('图片压缩后仍超过大小限制，请换一张图片。');
}

export async function cropImage(source,{title='调整图片',aspect=16/9,initial={},shape='rectangle',lockedAspect=false,signal,...output}={}){
  if(signal?.aborted)return null;
  const outputOptions=cropOutputOptions(output),circle=shape==='circle',ratioLocked=circle||lockedAspect===true;
  const targetAspect=circle?1:Number.isFinite(aspect)&&aspect>0?aspect:16/9;
  if(!(source instanceof Blob)||!/^image\/(png|jpeg|webp)$/.test(source.type)||source.size>8*1024*1024)throw new Error('请选择8 MB以内的 PNG、JPEG 或 WebP 图片。');
  const bitmap=await createImageBitmap(source).catch(()=>{throw new Error('图片无法读取。');});
  if(signal?.aborted){bitmap.close();return null;}
  if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>100000000){bitmap.close();throw new Error('图片尺寸过大。');}
  return new Promise((resolve,reject)=>{
    let dialog,url,observer,abort,cleaned=false;
    const cleanup=()=>{if(cleaned)return;cleaned=true;observer?.disconnect();if(url)URL.revokeObjectURL(url);if(abort)signal?.removeEventListener('abort',abort);bitmap.close();dialog?.remove();};
    try{
    dialog=document.createElement('dialog');dialog.className='image-cropper';dialog.dataset.shape=circle?'circle':'rectangle';
    dialog.innerHTML='<header><button type="button" data-cancel>取消</button><h2></h2><button type="button" data-done>完成</button></header><div class="crop-stage"><div class="crop-frame" aria-label="拖动图片调整位置"><img alt="待裁剪的图片" draggable="false"></div></div><footer><p>拖动调整位置 · 双指或滑杆缩放</p><label data-ratio-row>裁剪比例<select aria-label="裁剪比例"><option value="target">适合当前区域</option><option value="original">原图比例</option><option value="square">方形</option><option value="portrait">竖向</option><option value="landscape">横向</option></select></label><div class="crop-zoom"><span>缩放</span><input type="range" min="1" max="4" step="0.01" aria-label="图片缩放"><output></output><button type="button" data-reset>还原</button></div><p role="status" aria-live="polite"></p></footer>';
    dialog.querySelector('h2').textContent=title;document.body.append(dialog);
    const stage=dialog.querySelector('.crop-stage'),frame=dialog.querySelector('.crop-frame'),image=frame.querySelector('img'),zoom=dialog.querySelector('input'),zoomOutput=dialog.querySelector('output'),ratio=dialog.querySelector('select'),reset=dialog.querySelector('[data-reset]');
    url=URL.createObjectURL(source);image.src=url;
    const state={scale:Math.max(1,Math.min(4,Number(initial.scale)||1)),x:Math.max(0,Math.min(1,Number.isFinite(initial.x)?initial.x:.5)),y:Math.max(0,Math.min(1,Number.isFinite(initial.y)?initial.y:.5)),ratio:!ratioLocked&&['target','original','square','portrait','landscape'].includes(initial.ratio)?initial.ratio:'target'};
    ratio.value=state.ratio;dialog.querySelector('[data-ratio-row]').hidden=ratioLocked;ratio.disabled=ratioLocked;let result=null,busy=false;const pointers=new Map();let drag=null,pinch=null;
    const activeRatio=()=>({original:bitmap.width/bitmap.height,square:1,portrait:3/4,landscape:16/9})[state.ratio]||targetAspect;
    const geometry=()=>{const rect=frame.getBoundingClientRect(),fit=Math.max(rect.width/bitmap.width,rect.height/bitmap.height)*state.scale,w=bitmap.width*fit,h=bitmap.height*fit;return {width:rect.width,height:rect.height,w,h,left:-(w-rect.width)*state.x,top:-(h-rect.height)*state.y};};
    const update=()=>{if(!dialog.open)return;const a=activeRatio(),rect=stage.getBoundingClientRect(),style=getComputedStyle(stage),px=value=>parseFloat(value)||0,width=Math.max(1,rect.width-px(style.paddingLeft)-px(style.paddingRight)),height=Math.max(1,rect.height-px(style.paddingTop)-px(style.paddingBottom)),size=Math.min(640,width,height*a);frame.style.width=size+'px';frame.style.height=size/a+'px';frame.style.aspectRatio=String(a);const g=geometry();Object.assign(image.style,{width:g.w+'px',height:g.h+'px',left:g.left+'px',top:g.top+'px'});zoom.value=state.scale;zoomOutput.textContent=Math.round(state.scale*100)+'%';};
    const resetPointers=()=>{drag=null;pinch=null;if(pointers.size===1){const p=[...pointers.values()][0];drag={...p,x:state.x,y:state.y};}else if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.px-b.px,a.py-b.py),scale:state.scale};}};
    frame.onpointerdown=event=>{if(busy)return;event.preventDefault();frame.setPointerCapture(event.pointerId);pointers.set(event.pointerId,{px:event.clientX,py:event.clientY});resetPointers();};
    frame.onpointermove=event=>{if(busy||!pointers.has(event.pointerId))return;pointers.set(event.pointerId,{px:event.clientX,py:event.clientY});if(pointers.size===2&&pinch){const [a,b]=[...pointers.values()];state.scale=Math.max(1,Math.min(4,pinch.scale*Math.hypot(a.px-b.px,a.py-b.py)/Math.max(1,pinch.distance)));}else if(drag){const g=geometry();state.x=Math.max(0,Math.min(1,drag.x-(event.clientX-drag.px)/Math.max(1,g.w-g.width)));state.y=Math.max(0,Math.min(1,drag.y-(event.clientY-drag.py)/Math.max(1,g.h-g.height)));}update();};
    const end=event=>{pointers.delete(event.pointerId);resetPointers();};frame.onpointerup=end;frame.onpointercancel=end;frame.onlostpointercapture=end;
    frame.onwheel=event=>{event.preventDefault();if(busy)return;state.scale=Math.max(1,Math.min(4,state.scale-event.deltaY*.002));update();};
    zoom.oninput=()=>{if(busy)return;state.scale=Number(zoom.value);update();};ratio.onchange=()=>{if(busy||ratioLocked)return;state.ratio=ratio.value;state.x=state.y=.5;update();};reset.onclick=()=>{if(busy)return;Object.assign(state,{scale:1,x:.5,y:.5,ratio:'target'});ratio.value='target';update();};
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
    dialog.querySelector('[data-done]').onclick=async()=>{if(busy)return;busy=true;const button=dialog.querySelector('[data-done]'),crop={...state},canvas=document.createElement('canvas');button.disabled=zoom.disabled=reset.disabled=true;ratio.disabled=true;pointers.clear();resetPointers();dialog.querySelector('[role=status]').textContent='';try{const g=geometry(),factor=Math.min(outputOptions.maxOutputSize/g.width,outputOptions.maxOutputSize/g.height);canvas.width=Math.max(1,Math.round(g.width*factor));canvas.height=Math.max(1,Math.round(g.height*factor));const context=canvas.getContext('2d');if(!context)throw new Error('图片无法保存，请重试。');if(outputOptions.outputType==='image/jpeg'){context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);}context.drawImage(bitmap,g.left*factor,g.top*factor,g.w*factor,g.h*factor);const blob=await encodeCropCanvas(canvas,outputOptions,()=>!dialog.open);if(!dialog.open)return;result={blob,source,crop};dialog.close();}catch(error){if(dialog.open)dialog.querySelector('[role=status]').textContent=error.message;}finally{canvas.width=canvas.height=0;busy=false;if(dialog.open){button.disabled=zoom.disabled=reset.disabled=false;ratio.disabled=ratioLocked;}}};
    observer=new ResizeObserver(update);observer.observe(stage);dialog.addEventListener('close',()=>{cleanup();resolve(result);},{once:true});
    abort=()=>{if(dialog.open)dialog.close();else{cleanup();resolve(null);}};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    dialog.showModal();update();
    }catch(error){cleanup();reject(error);}
  });
}
