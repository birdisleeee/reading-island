// IndexedDB returns fresh Blob objects even when the saved image is unchanged.
// Compare only the rendered bytes; source/crop/size metadata can change separately.
// A 1920px canvas crop fits this bound. Larger legacy records safely get a new URL.
export const ARTWORK_COMPARE_LIMIT=16*1024*1024;
export async function sameArtworkBlob(previous,next){
  const left=previous instanceof Blob?previous:null,right=next instanceof Blob?next:null;
  if(left===right)return true;
  if(!left||!right||left.type!==right.type||left.size!==right.size||left.size>ARTWORK_COMPARE_LIMIT)return false;
  const [a,b]=await Promise.all([left.arrayBuffer(),right.arrayBuffer()]);
  const first=new Uint8Array(a),second=new Uint8Array(b);
  if(first.length!==second.length)return false;
  for(let i=0;i<first.length;i++)if(first[i]!==second[i])return false;
  return true;
}
