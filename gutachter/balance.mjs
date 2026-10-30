// Prints the buyer's (or a given address's) preprod lovelace balance via Blockfrost.
// node balance.mjs [address] [--wait <minutes>]  polls every 2 min until funded or timeout.
const BF='https://cardano-preprod.blockfrost.io/api/v0';
const args=process.argv.slice(2);
const waitAt=args.indexOf('--wait');
const waitMin=waitAt>=0?Number(args.splice(waitAt,2)[1]):0;
const address=args[0]??process.env.GUTACHTER_BUYER_ADDRESS;
if(!address||!process.env.BLOCKFROST_API_KEY_PREPROD) throw new Error('Need an address (or GUTACHTER_BUYER_ADDRESS) and BLOCKFROST_API_KEY_PREPROD');

async function lovelaceAt(addr){
 const res=await fetch(`${BF}/addresses/${addr}`,{headers:{project_id:process.env.BLOCKFROST_API_KEY_PREPROD}});
 if(res.status===404) return 0n;
 if(!res.ok) throw new Error(`Blockfrost HTTP ${res.status}`);
 const {amount}=await res.json();
 return BigInt(amount.find(a=>a.unit==='lovelace')?.quantity??'0');
}

const deadline=Date.now()+waitMin*60_000;
for(;;){
 let line;
 try{ const l=await lovelaceAt(address); line=`${new Date().toISOString()} ${address} ${Number(l)/1e6} tADA`; if(l>0n){ console.log(line+' FUNDED'); break; } }
 catch(e){ line=`${new Date().toISOString()} error: ${e.message}`; }
 console.log(line);
 if(Date.now()>=deadline){ if(waitMin) console.log('TIMEOUT: still unfunded'); break; }
 await new Promise(r=>setTimeout(r,120_000));
}
