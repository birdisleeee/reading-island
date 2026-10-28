import {bad} from './security.js';
export const QUOTA_FIELDS=['books','threads','bytes','requestsPerDay'];
export const emptyQuota=()=>Object.fromEntries(QUOTA_FIELDS.map(k=>[k,0]));
export const suggestedQuota={books:20,threads:200,bytes:100*1048576,requestsPerDay:1000};
export const initialPolicy={expectedRevision:0,registrationOpen:true,maxActiveAccounts:3,maxAccounts:30,maxPending:10,globalRequestsPerDay:3000,quotaBudget:Object.fromEntries(QUOTA_FIELDS.map(k=>[k,suggestedQuota[k]*3]))};
export function validateQuota(q){
 const ceilings={books:1000,threads:100000,bytes:1024*1024*1024,requestsPerDay:1000000};
 if(!q||QUOTA_FIELDS.some(k=>!Number.isSafeInteger(q[k])||q[k]<0||q[k]>ceilings[k]))bad('请填写技术上限内的非负整数额度');
 return Object.fromEntries(QUOTA_FIELDS.map(k=>[k,q[k]]));
}
