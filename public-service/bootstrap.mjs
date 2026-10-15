import {initialPolicy} from './quota.mjs';
const origin=new URL(process.env.PUBLIC_SERVICE_URL).origin,key=process.env.PUBLIC_OWNER_KEY;
if(!key||key.length<32)throw Error('Set a strong PUBLIC_OWNER_KEY in the environment.');
const login=await fetch(origin+'/service/api/owner-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({key})});
if(!login.ok)throw Error('Owner sign-in failed: '+login.status);
const cookie=login.headers.get('set-cookie').split(';')[0],headers={Origin:origin,Cookie:cookie,'Content-Type':'application/json'};
try{
 const current=await(await fetch(origin+'/service/api/owner/list',{headers})).json();
 if(current.policy?.revision!==0||current.users?.length)throw Error('Service already initialized; review the existing policy instead.');
 const response=await fetch(origin+'/service/api/owner/policy',{method:'POST',headers,body:JSON.stringify(initialPolicy)});
 if(!response.ok)throw Error('Policy initialization failed: '+response.status);
 console.log('Applications open; 3 approval slots; zero approved accounts.');
}finally{await fetch(origin+'/service/api/logout',{method:'POST',headers,body:'{}'});}
