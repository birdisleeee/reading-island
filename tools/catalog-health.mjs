import {searchBookCatalog,catalogFailureDiagnostic} from '../src/cloudflare/book-catalog.mjs';

// One anonymous metadata request from this machine. No credentials, user quota, book download or retries.
const query=process.argv.slice(2).join(' ')||'Pride and Prejudice',startedAt=Date.now();let requests=0;
const context={source:'Gutendex',network:'this machine; not the hosted Cloudflare Worker',observed_at:new Date().toISOString(),automatic_retries:0};
try{
  const result=await searchBookCatalog({query},(url,options)=>{requests++;return fetch(url,options);});
  console.log(JSON.stringify({...context,requests,ok:true,elapsed_ms:Date.now()-startedAt,candidates:result.items.length}));
}catch(error){
  console.log(JSON.stringify({...context,requests,ok:false,error:typeof error?.code==='string'&&/^(catalog_|invalid_)/.test(error.code)?error.code:'catalog_service_error',diagnostic:catalogFailureDiagnostic(error,{phase:'search',startedAt})}));
  process.exitCode=1;
}
