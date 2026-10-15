// Dismiss only gestures which start and finish outside the dialog.
export function dismissOnOutside(dialog){
  let pointer=null;
  const outside=event=>{const r=dialog.getBoundingClientRect();return event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom;};
  dialog.addEventListener('pointerdown',event=>{pointer=event.target===dialog&&outside(event)?event.pointerId:null;});
  dialog.addEventListener('pointerup',event=>{const dismiss=event.pointerId===pointer&&event.target===dialog&&outside(event);pointer=null;if(dismiss&&dialog.dispatchEvent(new Event('cancel',{cancelable:true})))dialog.close();});
  dialog.addEventListener('pointercancel',()=>{pointer=null;});
}
