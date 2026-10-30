// Abnahme MPS wallets: list roles, addresses and Preprod balances; optionally add the
// RechnungsMeister selling wallet; save the identifiers the registration scripts read.
// Never prints mnemonics or keys. Run from the repo root:
//   node --env-file=.env --env-file=.local/mps.env mps/wallets.mjs            # status + balances
//   node --env-file=.env --env-file=.local/mps.env --env-file=.local/mps-secrets.env mps/wallets.mjs add-rm
import fs from 'node:fs';
const USDM='16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const RM_NOTE='RechnungsMeister selling';
const base=process.env.MPS_URL+'/api/v1';
async function mps(path,method='GET',body){const r=await fetch(base+path,{method,headers:{token:process.env.ADMIN_KEY,'content-type':'application/json'},body:body&&JSON.stringify(body)});const j=await r.json();if(!r.ok||j.status!=='success')throw Error(`${method} ${path} ${r.status}: ${JSON.stringify(j.error??j.message??{})}`);return j.data;}
async function balance(address){
 const r=await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}`,{headers:{project_id:process.env.BLOCKFROST_API_KEY_PREPROD}});
 if(r.status===404)return {tADA:0,tUSDM:0};
 if(!r.ok)throw Error(`Blockfrost ${r.status}`);
 const amount=(await r.json()).amount;const q=u=>Number(amount.find(a=>a.unit===u)?.quantity??0)/1e6;
 return {tADA:q('lovelace'),tUSDM:q(USDM)};
}
const {PaymentSources}=await mps('/payment-source?take=100');
const source=PaymentSources.find(s=>s.network==='Preprod'&&s.paymentSourceType==='Web3CardanoV2');
if(!source)throw Error('No Preprod Web3CardanoV2 payment source');
const list=async()=>(await mps(`/wallet/list?take=100&paymentSourceId=${source.id}`)).Wallets;
let wallets=await list();
if(process.argv[2]==='add-rm'&&!wallets.some(w=>w.type==='Selling'&&w.note===RM_NOTE)){
 const words=process.env.RM_SELLING_WALLET_PREPROD_MNEMONIC;
 if(!words||words.split(' ').length!==24)throw Error('RM_SELLING_WALLET_PREPROD_MNEMONIC missing (pass --env-file=.local/mps-secrets.env)');
 await mps('/payment-source-extended','PATCH',{id:source.id,AddSellingWallets:[{walletMnemonic:words,note:RM_NOTE,collectionAddress:null}]});
 wallets=await list();
}
const seeded=wallets.filter(w=>w.note==='Created by V2 seeding');
const roles=[
 ['Büro-Agent selling (Abnahme-Büro)','docs/payment-state.json',seeded.find(w=>w.type==='Selling')],
 ['RechnungsMeister selling','docs/rechnungsmeister-payment-state.json',wallets.find(w=>w.type==='Selling'&&w.note===RM_NOTE)],
 ['Büro-Agent purchasing (buys RechnungsMeister)','docs/buero-purchasing-state.json',seeded.find(w=>w.type==='Purchasing')],
];
const out=[];
for(const [role,file,w] of roles){
 if(!w){out.push({role,missing:true});continue;}
 const state=w.type==='Selling'?{sourceId:source.id,walletId:w.id,sellerAddress:w.walletAddress}:{sourceId:source.id,walletId:w.id,walletVkey:w.walletVkey,walletAddress:w.walletAddress};
 if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file));if(old.walletId!==w.id)throw Error(`${file} holds another wallet; inspect before overwriting`);}
 else fs.writeFileSync(file,JSON.stringify(state,null,2));
 out.push({role,type:w.type,walletId:w.id,walletVkey:w.walletVkey,address:w.walletAddress,...await balance(w.walletAddress)});
}
console.log(JSON.stringify({sourceId:source.id,smartContractAddress:source.smartContractAddress,wallets:out},null,1));
