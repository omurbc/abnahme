// Send tADA from one of our MPS hot wallets to another address (MPS POST /wallet/transfer-funds, admin key).
// Run from the repo root:
//   node --env-file=.env --env-file=.local/mps.env mps/fund.mjs <fromHotWalletAddress> <toAddress> <ada>
const [from,to,ada]=process.argv.slice(2);
if(!from||!to||!(Number(ada)>=2))throw Error('usage: mps/fund.mjs <fromHotWalletAddress> <toAddress> <ada >= 2>');
const base=(process.env.MPS_URL||'http://127.0.0.1:38127')+'/api/v1';
const r=await fetch(base+'/wallet/transfer-funds',{method:'POST',headers:{token:process.env.ADMIN_KEY,'content-type':'application/json'},body:JSON.stringify({fromWalletAddress:from,toAddress:to,lovelaceAmount:String(Math.round(Number(ada)*1e6))})});
const j=await r.json();
if(!r.ok||j.status!=='success')throw Error(`transfer-funds ${r.status}: ${JSON.stringify(j.error??j.message??j)}`);
console.log(`queued ${ada} tADA -> ${to.slice(0,20)}… transfer ${j.data.id} status ${j.data.status}`);
