import {ReadingError,requireValue} from './validation.mjs';
import {coverType} from './covers.mjs';

export const AVATAR_DATA_LIMIT=48*1024;
const PREFIX='data:image/jpeg;base64,';
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// The browser normalizes avatars to a small 256px JPEG. This endpoint never
// fetches an external URL or stores arbitrary user-supplied image markup.
export function validateAvatarData(value){
  requireValue(typeof value==='string','invalid_avatar_data');
  requireValue(value.length<=AVATAR_DATA_LIMIT,'avatar_too_large',413);
  if(value==='')return '';
  requireValue(value.startsWith(PREFIX),'invalid_avatar_data');
  const encoded=value.slice(PREFIX.length);
  requireValue(encoded.length>0&&encoded.length%4===0&&BASE64.test(encoded),'invalid_avatar_data');
  let decoded;
  try{decoded=atob(encoded);}catch{throw new ReadingError(400,'invalid_avatar_data');}
  requireValue(btoa(decoded)===encoded,'invalid_avatar_data');
  const bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));
  try{requireValue(coverType(bytes)==='image/jpeg','invalid_avatar_image',415);}catch{throw new ReadingError(415,'invalid_avatar_image');}
  const view=new DataView(bytes.buffer);let at=2,width=0,height=0,hasScan=false;
  while(at+4<bytes.length){
    requireValue(bytes[at++]===0xff,'invalid_avatar_image',415);
    while(bytes[at]===0xff)at++;
    const marker=bytes[at++];
    if(marker===1||marker>=0xd0&&marker<=0xd7)continue;
    requireValue(at+2<=bytes.length,'invalid_avatar_image',415);
    const length=view.getUint16(at);
    requireValue(length>=2&&at+length<=bytes.length-2,'invalid_avatar_image',415);
    if([0xc0,0xc1,0xc2].includes(marker)){
      requireValue(!width&&length>=8&&bytes[at+2]===8,'invalid_avatar_image',415);
      height=view.getUint16(at+3);width=view.getUint16(at+5);
      const components=bytes[at+7];
      requireValue([1,3].includes(components)&&length===8+3*components,'invalid_avatar_image',415);
    }
    if(marker===0xda){
      requireValue(width===256&&height===256&&length>=6&&at+length<bytes.length-2,'invalid_avatar_image',415);
      hasScan=true;break;
    }
    at+=length;
  }
  requireValue(width===256&&height===256&&hasScan,'invalid_avatar_image',415);
  return value;
}
